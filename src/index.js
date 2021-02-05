const http = require('http');
const httpProxy = require('http-proxy');
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const SessionManager = require('./SessionManager.class.js');


const sessMan = new SessionManager();

const webServerPort = 80;
const gitRepoAccessToken = process.env.GIT_API_ACCESS_TOKEN;
const hirdApiAccessToken = process.env.HIRD_API_ACCESS_TOKEN;

const sessions = [];

var app = express();
app.use(bodyParser.urlencoded({ extended: true }));

let wsServer = new WebSocket.Server({ noServer: true });

wsServer.on('connection', socket => {
  socket.on('message', message => console.log("ws msg:", message));
});

const proxyServer = httpProxy.createProxyServer({
  ws: true
});


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

function checkAccessCode(req) {
  if(req.headers.hird_api_access_token != hirdApiAccessToken || typeof hirdApiAccessToken == "undefined") {
    console.log("Error: Invalid hird_api_access_token! Ignoring request.");
    return false;
  }
  return true;
}

//BEGIN HTTP ENDPOINTS
app.get('/*', (req, res, next) => {
  let parts = req.url.split("/");
  console.log(req.url);
  if(parts[1] != "api") {
    sessMan.routeToApp(req);
  }
  else {
    next();
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
    console.log(result);
    res.end(`{ "msg": "Committed ${result}", "level": "info" }`);
  }).catch((e) => {
    console.error("Error:"+e.toString('utf8'));
  });
});

app.get('/api/session/:session_id/delete', (req, res) => {
  let sess = getSessionByCode(req.params.session_id);
  if(sess === false) {
    console.error("Error on delete: Session not found!");
    res.end(`{ "msg": "Error on delete: Session not found! Session id:${req.params.session_id}", "level": "error" }`);
    return false;
  }
  sess.delete().then(() => {
    let sessId = sess.accessCode;
    removeSession(sess);
    res.end(`{ "deleted": "${sessId}" }`);
  }).catch((e) => {
    console.log(e.toString('utf8'));
  });
});

//This asks to create a new session for this user/project
app.post('/api/session/user', (req, res) => {
  let user = JSON.parse(req.body.gitlabUser);
  let project = JSON.parse(req.body.gitlabProject);
  let hsApp = req.body.hsApp; //This is currently hardcoded to 'rstudio' in webapi

  console.log("Received request access session for user", user.id, "and project", project.id, "with session", req.body.rstudioSession);
  
  if(typeof req.body.rstudioSession != "undefined") {
    let sess = sessMan.getSessionByCode(req.body.rstudioSession);
    if(sess !== false) {
      //Since session was found, return the access code to it - which tells the client to use this to connect to the existing session instead
      console.log("Existing session was found, sending project access code to api/proxy ")
      res.end(JSON.stringify({
        sessionAccessCode: sess.accessCode
      }));
      
      return;
    }
  }

  console.log("No existing session was found, creating container");
  (async () => {

    let sess = sessMan.createSession(user, project, hsApp);
    let containerId = await sess.createContainer();
    let gitOutput = await sess.cloneProjectFromGit(); //TODO: Process git output here to check that there were no errors

    sessions.push(sess);
    return sess;
  })().then((sess) => {
    console.log("Creating container complete, sending project access code to api/proxy");
    res.end(JSON.stringify({
      sessionAccessCode: sess.accessCode
    }));
  });

});

app.get('/api/session/commit/user/:user_id/project/:project_id/projectpath/:project_path', (req, res) => {
  console.log("Received request to commit session for user", req.params.user_id, "and project", req.params.project_id);
});

//END HTTP ENDPOINTS

sessMan.closeOrphanContainers();

const server = app.listen(webServerPort, () => {
  console.log("AppRouter online");
  console.log("Listening on port", webServerPort);
});

server.on('upgrade', (request, socket, head) => {
  console.log("upgrade!");
  wsServer.handleUpgrade(request, socket, head, (webSocket) => {
    wsServer.emit('connection', webSocket, request);
    sessMan.routeToApp(request, null, socket, true, head);
    //routeToRstudio(request, null, socket, true, head);
  });
});
