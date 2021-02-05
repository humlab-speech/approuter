const http = require('http');
const httpProxy = require('http-proxy');
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const fs = require('fs');
const SessionManager = require('./SessionManager.class.js');

const sessMan = new SessionManager();

const webServerPort = 80;
const gitRepoAccessToken = process.env.GIT_API_ACCESS_TOKEN;
const hsApiAccessToken = process.env.HS_API_ACCESS_TOKEN;

const sessions = [];

var app = express();
app.use(bodyParser.urlencoded({ extended: true }));

let wsServer = new WebSocket.Server({ noServer: true });

wsServer.on('connection', socket => {
  socket.on('message', message => addLog("ws msg:", message));
});

const proxyServer = httpProxy.createProxyServer({
  ws: true
});

function addLog(msg, level = 'info') {
  let levelMsg = new String(level).toUpperCase();
  let printMsg = new Date().toLocaleDateString("sv-SE")+" "+new Date().toLocaleTimeString("sv-SE")+" ["+levelMsg+"] "+msg;
  let logMsg = printMsg+"\n";
  switch(level) {
    case 'info':
      console.log(printMsg);
      fs.appendFileSync('./approuter.log', logMsg);
      break;
    case 'warn':
      console.warn(printMsg);
      fs.appendFileSync('./approuter.log', logMsg);
      break;
    case 'error':
      console.error(printMsg);
      fs.appendFileSync('./approuter.log', logMsg);
      break;
  }
}

function getCookies(req) {
  let cookiesParsed = [];
  let cookies = req.headers.cookie.split("; ");
  cookies.forEach((cookie) => {
    let cparts = cookie.split("=");
    let key = cparts[0];
    let value = cparts[1];
    cookiesParsed[key] = value;
  });

  return cookiesParsed;
}

function checkApiAccessCode(req) {
  if(req.headers.hs_api_access_token !== hsApiAccessToken || typeof hsApiAccessToken == "undefined") {
    addLog("Error: Invalid hird_api_access_token! Ignoring request.", 'warn');
    return false;
  }
  return true;
}

//BEGIN HTTP ENDPOINTS
app.get('/*', (req, res, next) => {
  let parts = req.url.split("/");
  addLog(req.url);
  if(parts[1] != "api") {
    sessMan.routeToApp(req);
  }
  else {
    if(!checkApiAccessCode(req)) { //Requests to the approuter API must always include the API access code, which should be held by the webapi service
      return false;
    }
    else {
      next();
    }
  }
});

app.post('/*', (req, res, next) => {
  let parts = req.url.split("/");
  if(parts[1] != "api") {
    sessMan.routeToApp(req);
  }
  else {
    next();
  }
});

app.get('/api/*', (req, res, next) => {
  /*
  if(!checkAccessCode(req)) {
    res.end("{ 'status': 'bad access code' }");
  }
  */
  next();
});

app.get('/api/sessions/:user_id', (req, res) => {
  let out = JSON.stringify(getUserSessions(req.params.user_id));
  res.end(out);
});

app.get('/api/session/:session_id/commit', (req, res) => {
  let sess = sessMan.getSessionByCode(req.params.session_id);
  if(sess === false) {
    //Todo: Add error handling here if session doesn't exist
    res.end(`{ "msg": "Session does not exist", "level": "error" }`);
  }
  sess.commit().then((result) => {
    addLog(result);
    res.end(`{ "msg": "Committed ${result}", "level": "info" }`);
  }).catch((e) => {
    addLog("Error:"+e.toString('utf8'), 'error');
  });
});

app.get('/api/session/:session_id/delete', (req, res) => {
  let sess = getSessionByCode(req.params.session_id);
  if(sess === false) {
    addLog("Error on delete: Session not found!", 'error');
    res.end(`{ "msg": "Error on delete: Session not found! Session id:${req.params.session_id}", "level": "error" }`);
    return false;
  }
  sess.delete().then(() => {
    let sessId = sess.accessCode;
    removeSession(sess);
    res.end(`{ "deleted": "${sessId}" }`);
  }).catch((e) => {
    addLog(e.toString('utf8'));
  });
});

//This asks to create a new session for this user/project
app.post('/api/session/user', (req, res) => {
  let user = JSON.parse(req.body.gitlabUser);
  let project = JSON.parse(req.body.gitlabProject);
  let hsApp = req.body.hsApp; //This is currently hardcoded to 'rstudio' in webapi

  addLog("Received request access session for user", user.id, "and project", project.id, "with session", req.body.rstudioSession);
  
  if(typeof req.body.rstudioSession != "undefined") {
    let sess = sessMan.getSessionByCode(req.body.rstudioSession);
    if(sess !== false) {
      //Since session was found, return the access code to it - which tells the client to use this to connect to the existing session instead
      addLog("Existing session was found, sending project access code to api/proxy ")
      res.end(JSON.stringify({
        sessionAccessCode: sess.accessCode
      }));
      
      return;
    }
  }

  addLog("No existing session was found, creating container");
  (async () => {

    let sess = sessMan.createSession(user, project, hsApp);
    let containerId = await sess.createContainer();
    let gitOutput = await sess.cloneProjectFromGit(); //TODO: Process git output here to check that there were no errors

    sessions.push(sess);
    return sess;
  })().then((sess) => {
    addLog("Creating container complete, sending project access code to api/proxy");
    res.end(JSON.stringify({
      sessionAccessCode: sess.accessCode
    }));
  });

});

app.get('/api/session/commit/user/:user_id/project/:project_id/projectpath/:project_path', (req, res) => {
  addLog("Received request to commit session for user", req.params.user_id, "and project", req.params.project_id);
});

//END HTTP ENDPOINTS

sessMan.closeOrphanContainers();

const server = app.listen(webServerPort, () => {
  addLog("AppRouter online");
  addLog("Listening on port", webServerPort);
});

server.on('upgrade', (request, socket, head) => {
  addLog("upgrade!");
  wsServer.handleUpgrade(request, socket, head, (webSocket) => {
    wsServer.emit('connection', webSocket, request);
    sessMan.routeToApp(request, null, socket, true, head);
    //routeToRstudio(request, null, socket, true, head);
  });
});
