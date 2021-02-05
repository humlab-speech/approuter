const child_process = require('child_process');
const Session = require('./Session.class');

class SessionManager {
    constructor() {
        this.rstudioImageName = process.env.RSTUDIO_IMAGE_NAME
    }

    createSession(user, project, hsApp = 'rstudio') {
        let sess = new Session(user, project, this.getAvailableSessionProxyPort(), hsApp);
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
            console.log(sessions);
            return false;
        }
        
        console.log("REQ:",req.url);
        
        if(ws) {
            console.log("Performing websocket routing");
            sess.proxyServer.ws(req, socket, {
            target: "ws://localhost:17890",
            ws: true,
            xfwd: true
            });
        }
        else {
            console.log("Performing http routing");
            sess.proxyServer.web(req, res);
        }
    }

    getSessionName(userId, projectId) {
        return "rstudio-session-p"+projectId+"u"+userId;
    }

    stopContainer(containerId) {

    }

    fetchActiveSessions() {
        let containers = this.getRunningSessions();
        return containers;
    }
      
    getSession(userId, projectId) {
    }
    
    getRunningContainers() {
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
      return sessions;
    }

    getSessionByCode(code) {
        let foundSession = false;
        sessions.forEach((session) => {
          if(session.accessCode == code) {
            foundSession = session;
          }
        });
        return foundSession;
      }

    getAvailableSessionProxyPort() {
        let portMin = 30000;
        let portMax = 35000;
        let selectedPort = portMin;
        let selectedPortInUse = true;
        while(selectedPortInUse) {
          selectedPortInUse = false;
          for(let key in sessions) {
            if(sessions[key].port == selectedPort) {
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
        for(let i = sessions.length-1; i > -1; i--) {
            if(sessions[i].accessCode == session.accessCode) {
            sessions.splice(i, 1);
            }
        }
    }
      
    getUserSessions(userId) {
        console.log("Getting user sessions for user", userId);
        let userSessions = [];
        for(let key in sessions) {
            if(sessions[key].user.id == userId) {
                userSessions.push({
                sessionCode: sessions[key].accessCode,
                projectId: sessions[key].project.id,
                'type': 'rstudio'
                });
            }
        }
        return userSessions;
      }

    closeOrphanContainers() {
        console.log("Closing any orphan session containers");
        let containers = this.getRunningContainers();
        containers.forEach((c) => {
          deleteContainer = true;
          sessions.forEach((s) => {
            if(c.id == s.shortDockerContainerId) {
              deleteContainer = false;
            }
          });
      
          if(deleteContainer) {
            let cmd = "docker stop "+c.id;
            child_process.exec(cmd, {}, () => {
              console.log("Stopped orphan container", c.id);
            });
          }
        });
      }

};

module.exports = SessionManager
