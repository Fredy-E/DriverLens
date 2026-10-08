const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

// createServer is the single module entrypoint for both the CLI below and the
// integration tests (tests/integration.test.cjs, tests/collector-harness.cjs).
// Tests inject runCollector / platform / reportPath so the /scan success,
// pending, and failure paths can be exercised without ever running
// Collect-DriverLens.ps1 or collecting real device data. Production defaults
// are unchanged: loopback-only listen, DRIVERLENS_PORT, pwsh collector, report
// beside the application.
function createServer(options = {}) {
  const port = Number(options.port || process.env.DRIVERLENS_PORT || 8781);
  const origin = `http://127.0.0.1:${port}`;
  const reportPath = options.reportPath || path.join(__dirname, 'driver-report.json');
  const platform = options.platform || process.platform;
  const runCollector = options.runCollector || ((done) => {
    const shell = process.env.DRIVERLENS_POWERSHELL || 'pwsh.exe';
    execFile(shell,['-NoProfile','-NonInteractive','-File',path.join(__dirname,'Collect-DriverLens.ps1'),'-OutputPath',reportPath],{timeout:120000,maxBuffer:1024*1024,windowsHide:true},done);
  });
  const files = new Map([['/', ['index.html','text/html']], ['/app.js',['app.js','text/javascript']], ['/style.css',['style.css','text/css']], ['/sample.json',['sample.json','application/json']]]);
  let busy = false;
  function send(res,status,data,type='application/json') { res.writeHead(status, {'Content-Type':`${type}; charset=utf-8`, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'}); res.end(data); }
  const server = http.createServer((req,res) => {
    if (req.headers.host !== `127.0.0.1:${port}`) return send(res,403,JSON.stringify({error:'Use the local 127.0.0.1 address.'}));
    // Malformed request targets (e.g. '//[::') must yield a 400, never an uncaught
    // ERR_INVALID_URL that kills the helper. Foreign absolute targets (scheme +
    // another origin) are rejected too; scheme-relative targets keep their
    // existing WHATWG-normalized behavior (they can only reach the fixed map).
    let url;
    try { url = new URL(req.url,origin); }
    catch { return send(res,400,JSON.stringify({error:'Invalid request target.'})); }
    if (/^[a-z][a-z0-9+.-]*:/i.test(req.url) && url.origin !== origin) return send(res,400,JSON.stringify({error:'Invalid request target.'}));
    if (req.method === 'POST' && url.pathname === '/scan') {
      if (req.headers.origin !== origin || req.headers['x-driverlens-scan'] !== '1') return send(res,403,JSON.stringify({error:'Scan must be requested from the local UI.'}));
      if (platform !== 'win32') return send(res,400,JSON.stringify({error:'Live scanning requires Windows.'}));
      if (busy) return send(res,409,JSON.stringify({error:'A scan is already running.'}));
      busy = true;
      runCollector((error,stdout,stderr)=>{
        busy=false;
        if(error) return send(res,500,JSON.stringify({error:'Inventory failed. Install PowerShell 7 or set DRIVERLENS_POWERSHELL to its executable; check script policy and WMI access.', detail:String(stderr||error.message).slice(0,600)}));
        fs.readFile(reportPath,(error,data)=>error?send(res,500,JSON.stringify({error:'Report could not be read.'})):send(res,200,data));
      });
      return;
    }
    if (req.method !== 'GET') return send(res,405,JSON.stringify({error:'Method not allowed.'}));
    if (url.pathname === '/ping') { const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64'); res.writeHead(200,{'Content-Type':'image/gif','Cache-Control':'no-store','Content-Length':pixel.length}); return res.end(pixel); }
    if (url.pathname === '/report') return fs.readFile(reportPath,(error,data)=>error?send(res,404,JSON.stringify({error:'No local scan saved yet.'})):send(res,200,data));
    const file = files.get(url.pathname);
    if (!file) return send(res,404,JSON.stringify({error:'Not found.'}));
    fs.readFile(path.join(__dirname,file[0]),(error,data)=>error?send(res,404,JSON.stringify({error:'Not found.'})):send(res,200,data,file[1]));
  });
  return { server, port, origin };
}

if (require.main === module) {
  const { server, port, origin } = createServer();
  server.listen(port, '127.0.0.1', () => console.log(`DriverLens: ${origin} — choose Scan this PC for a read-only inventory.`));
}

module.exports = { createServer };
