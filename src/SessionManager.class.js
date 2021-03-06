const child_process = require('child_process');
const nanoid = require('nanoid');
const Session = require('./Session.class');
const fetch = require('node-fetch');
const { Docker } = require('node-docker-api');

class SessionManager {
    constructor(app) {
      this.app = app;
      this.rstudioImageName = process.env.RSTUDIO_IMAGE_NAME
      this.sessions = [];
      this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
    }
    
    getContainerAccessCode() {
      let code = nanoid.nanoid(32);
      while(this.checkIfCodeIsUsed(code)) {
        code = nanoid.nanoid(32);
      }
      return code;
    }

    checkIfCodeIsUsed(code) {
      for(let key in this.sessions) {
        if(this.sessions[key].accessCode == code) {
          return true;
        }
      }
      return false;
    }

    getUserSessions(userId) {
      this.app.addLog("Getting user sessions for user "+userId);
      let userSessions = [];
      for(let key in this.sessions) {
        if(this.sessions[key].user.id == userId) {
          userSessions.push({
            sessionCode: this.sessions[key].accessCode,
            projectId: this.sessions[key].project.id,
            type: 'rstudio'
          });
        }
      }
      return userSessions;
    }

    createSession(user, project, hsApp = 'rstudio') {
        let sess = new Session(this.app, user, project, this.getAvailableSessionProxyPort(), hsApp);
        this.sessions.push(sess);
        return sess;
    }

    getSessionAccessCodeFromRequest(req) {
        let sessionAccessCode = false;
        if(typeof req.headers.cookie != "undefined") {
            let cookies = req.headers.cookie.split("; ");
            cookies.forEach((cookie) => {
            let cparts = cookie.split("=");
            let key = cparts[0];
            let value = cparts[1];
            switch(key) {
                case "rstudioSession":
                sessionAccessCode = value;
                break;
            }
            });
        }
        return sessionAccessCode;
      }

    routeToApp(req, res = null, socket = null, ws = false, head = null) {
        let sessionAccessCode = this.getSessionAccessCodeFromRequest(req);
        if(sessionAccessCode === false) {
            console.warn("Couldn't perform routing to app because we couldn't get a sessionAccessCode from the request!");
            return false;
        }
        
        let sess = this.getSessionByCode(sessionAccessCode);
        if(sess === false) {
            console.warn("Couldn't find a session with code", sessionAccessCode);
            this.app.addLog(this.sessions);
            return false;
        }
        
        this.app.addLog("REQ:"+req.url, "debug");
        
        if(ws) {
            this.app.addLog("Performing websocket routing");
            sess.proxyServer.ws(req, socket, {
            target: "ws://localhost:17890",
            ws: true,
            xfwd: true
            });
        }
        else {
            this.app.addLog("Performing http routing", "debug");
            sess.proxyServer.web(req, res);
        }
    }

    getSessionName(userId, projectId) {
        return "rstudio-session-p"+projectId+"u"+userId;
    }

    stopContainer(containerId) {

    }

    fetchActiveSessionsOLD() {
        let containers = this.getRunningSessions();
        return containers;
    }

    /*
    async fetchSessionContainers() {
      return await docker.container.list()
      .then((containers) => {
          let filteredList = containers.filter((container) => {
            return container.data.Image == "hird-rstudio-emu";
          });

          return filteredList;
        });
    }
    */
      
    getSession(userId, projectId) {
      for(let key in this.sessions) {
        if(this.sessions[key].user.id == userId && this.sessions[key].project.id == projectId) {
          return this.sessions[key];
        }
      }
      return false;
    }
    
    getRunningContainers() {
      /*
      (async () => {
        await docker.container.list()
        .then((containers) => {
            let filteredList = containers.filter((container) => {
              return container.data.Image == "hird-rstudio-emu";
            });

            return filteredList;
          });
      })();

      return await fetchSessionContainers();
      */

      /*
      let cmd = "docker ps --format='{{json .}}'";
      let dockerContainersJson = child_process.execSync(cmd).toString('utf8');
      let containersJson = dockerContainersJson.split("\n");
      containersJson.pop();
      let sessions = [];
      containersJson.forEach((containerJson) => {
        let containerInfo = JSON.parse(containerJson);
        //Filter out non-rstudio
        if(containerInfo.Image == this.rstudioImageName) {
          sessions.push({
            id: containerInfo.ID,
            name: containerInfo.Names,
            runningFor: containerInfo.RunningFor,
            status: containerInfo.Status
          });
        }
      });
      this.sessions = sessions;
      return sessions;
      */
    }

    getSessionByCode(code) {
      code = code.toString('utf8');
      for(let key in this.sessions) {
        this.app.addLog(this.sessions[key].accessCode+" "+code);
        if(this.sessions[key].accessCode == code) {
          return this.sessions[key];
        }
      }
      return false;
    }

    getAvailableSessionProxyPort() {
        let portMin = 30000;
        let portMax = 35000;
        let selectedPort = portMin;
        let selectedPortInUse = true;
        while(selectedPortInUse) {
          selectedPortInUse = false;
          for(let key in this.sessions) {
            if(this.sessions[key].port == selectedPort) {
              selectedPortInUse = true;
            }
          }
          if(selectedPortInUse) {
            if(selectedPort < portMax) {
              selectedPort++;
            }
            else {
              return false;
            }
          }
          else {
            return selectedPort;
          }
        }
        
        return false;
      }

    removeSession(session) {
        for(let i = this.sessions.length-1; i > -1; i--) {
            if(this.sessions[i].accessCode == session.accessCode) {
              this.sessions.splice(i, 1);
            }
        }
    }

    /**
     * Function: importRunningContainers
     * This is indented to import any existing running sessions, in case the cluster was restarted while sessians were active
     */
    async importRunningContainers() {
      this.app.addLog("Importing existing session containers");

      await new Promise((resolve, reject) => {

        this.docker.container.list().then(containers => {
          let filteredList = containers.filter((container) => {
            return container.data.Image == "hird-rstudio-emu";
          });
  
          let userIds = [];
          let users = [];
  
          let projectIds = [];
          let projects = [];
  
          let fetchPromises = [];
  
          filteredList.forEach((c) => {
            let hsApp = c.data.Labels['hs.hsApp'];
            let userId = c.data.Labels['hs.userId'];
            let projectId = c.data.Labels['hs.projectId'];
            let accessCode = c.data.Labels['hs.accessCode'];
            
  
            //Only fetch if we are not already fetching info for this user
            if(userIds.indexOf(userId) == -1) {
              this.app.addLog("Fetching user "+userId);
              userIds.push(userId);
              let p = fetch(this.app.gitlabAddress+"/api/v4/users?id="+userId+"&private_token="+this.app.gitlabAccessToken)
              .then(response => response.json())
              .then(data => {
                users.push(data[0]);
              });
  
              fetchPromises.push(p);
            }
  
            //Only fetch if we are not already fetching info for this project
            if(projectIds.indexOf(projectId) == -1) {
              this.app.addLog("Fetching project "+projectId);
              projectIds.push(projectId);
              let p = fetch(this.app.gitlabAddress+"/api/v4/projects?id="+projectId+"&private_token="+this.app.gitlabAccessToken)
              .then(response => response.json())
              .then(data => {
                projects.push(data[0]);
              });
  
              fetchPromises.push(p);
            }
            
          });
  
          Promise.all(fetchPromises).then(data => {
            this.app.addLog("Promises data:"+data);
            filteredList.forEach((c) => {
              let hsApp = c.data.Labels['hs.hsApp'];
              let userId = c.data.Labels['hs.userId'];
              let projectId = c.data.Labels['hs.projectId'];
              let accessCode = c.data.Labels['hs.accessCode'];
  
              let userObj = null;
              users.forEach(user => {
                if(user.id == userId) {
                  userObj = user;
                }
              });
              let projObj = null;
              projects.forEach(project => {
                if(project.id == projectId) {
                  projObj = project;
                }
              });
  
              this.app.addLog("Importing existing session: App:"+hsApp+" User:"+userObj.id+" Proj:"+projObj.id);
              
              let session = new Session(this.app, userObj, projObj, this.getAvailableSessionProxyPort(), hsApp);
              session.setAccessCode(accessCode);
              session.loadContainerId().then((shortDockerContainerId) => {
                session.setupProxyServerIntoContainer(shortDockerContainerId);
              });
              
              this.sessions.push(session);
  
            });

            resolve();
          });
  
        });

        
      });

      
    }

    /**
     * Function: closeOrphanContainers
     * WARNING: This has not been updated to use Docker API
     */

     /*
    closeOrphanContainers() {
      this.app.addLog("Closing any orphan session containers");

      let containers = this.importRunningContainers();
      containers.forEach((c) => {
        deleteContainer = true;
        this.sessions.forEach((s) => {
          if(c.id == s.shortDockerContainerId) {
            deleteContainer = false;
          }
        });
    
        if(deleteContainer) {
          let cmd = "docker stop "+c.id;
          child_process.exec(cmd, {}, () => {
            this.app.addLog("Stopped orphan container", c.id);
          });
        }
      });
    }
    */

};

module.exports = SessionManager
