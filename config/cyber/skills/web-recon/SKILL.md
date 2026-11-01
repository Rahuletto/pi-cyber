---
description: "Exhaustive web application recon: passive DNS/OSINT, subdomain enum, port scan, HTTP fingerprinting, content discovery, JS analysis, parameter discovery. Use at start of any web app engagement."
---

# SKILL — web-recon

## Purpose
Exhaustive web application reconnaissance. Produces a complete target profile covering infrastructure, technology stack, attack surface, endpoints, authentication mechanisms, and prioritized vectors.

## When to load
- Given a URL or domain to recon
- Starting a web app pentest or bug bounty
- Need to map endpoints, tech stack, or attack surface
- Preparing for exploitation — need complete picture first

## Phase 0 — Setup

```bash
TARGET="target.com"
mkdir -p ~/recon_$(date +%s)_${TARGET}/{recon/{dns,subdomains,ports,http,tech,osint,js},vulns/{confirmed,potential,research},exploits/{working,attempted},loot/{credentials,data,flags}}
export TARGET="target.com"
export TARGET_IP=$(dig +short $TARGET | head -1)
```

## Phase 1 — Passive intelligence (zero packets to target)

```bash
# All DNS record types
for type in A AAAA MX NS TXT SOA CNAME SRV CAA DNSKEY; do
  echo "=== $type ===" && dig $TARGET $type +short
done | tee recon/dns/all-records.txt

# Zone transfer attempt against every nameserver
for ns in $(dig $TARGET NS +short); do
  dig axfr $TARGET @$ns
done | tee recon/dns/zone-transfers.txt

# Certificate Transparency — subdomain harvest
curl -s "https://crt.sh/?q=%25.$TARGET&output=json" \
  | jq -r '.[].name_value' | sed 's/\*\.//g' | sort -u \
  | tee recon/subdomains/crtsh.txt

# WHOIS and ASN
whois $TARGET | tee recon/osint/whois-domain.txt
curl -s "https://ipinfo.io/$TARGET_IP/json" | tee recon/osint/ipinfo.json

# Web archive URL harvest
curl -s "https://web.archive.org/cdx/search/cdx?url=*.$TARGET/*&output=text&fl=original&collapse=urlkey&limit=5000" \
  | sort -u | tee recon/osint/wayback-urls.txt

# Google dorks (manual)
# site:$TARGET ext:php
# site:$TARGET ext:env OR ext:config OR ext:yml OR ext:sql
# site:$TARGET inurl:admin OR inurl:login OR inurl:dashboard
# "$TARGET" site:pastebin.com OR site:github.com
```

## Phase 2 — Subdomain enumeration (active)

```bash
subfinder -d $TARGET -all -o recon/subdomains/subfinder.txt
cat recon/subdomains/*.txt | sort -u > recon/subdomains/all.txt
dnsx -l recon/subdomains/all.txt -a -cname -o recon/dns/resolved.txt -silent
httpx -l recon/dns/resolved.txt -title -tech-detect -status-code -follow-redirects \
  -o recon/http/live-subdomains.txt -silent

# Subdomain takeover check
for sub in $(cat recon/subdomains/all.txt); do
  cname=$(dig +short CNAME $sub)
  if [ ! -z "$cname" ] && ! dig +short $cname | grep -q "[0-9]"; then
    echo "[!] POTENTIAL TAKEOVER: $sub -> $cname" | tee -a recon/vulns/potential/subdomain-takeover.txt
  fi
done
```

## Phase 3 — Port and service discovery

```bash
naabu -host $TARGET -p 80,443,8080,8443,8888,3000,4000,5000,9090,9443,10000,8000,8001 \
  -o recon/ports/web-ports.txt -silent
nmap -sV --open -oA recon/ports/top1000 $TARGET_IP
nmap -sV -sC -p- --min-rate 3000 --open -oA recon/ports/full-tcp $TARGET_IP &
```

## Phase 4 — HTTP fingerprinting

```bash
URL="https://$TARGET"
curl -sI $URL | tee recon/tech/headers.txt
httpx -u $URL -tech-detect -title -status-code -content-length -follow-redirects -verbose 2>&1 \
  | tee recon/tech/httpx.txt

# Security headers check
for header in "Strict-Transport-Security" "Content-Security-Policy" "X-Frame-Options" \
  "X-Content-Type-Options" "X-XSS-Protection" "Referrer-Policy" "Permissions-Policy"; do
  val=$(curl -sI $URL | grep -i "^$header:")
  [ -z "$val" ] && echo "[MISSING] $header" || echo "[PRESENT] $val"
done

# Default disclosure files
for path in robots.txt sitemap.xml .well-known/security.txt .git/HEAD .env \
  /actuator /actuator/env /swagger.json /swagger-ui.html /api-docs /openapi.json \
  CHANGELOG.txt /phpinfo.php /server-status /.DS_Store; do
  code=$(curl -so /dev/null -w "%{http_code}" -L "$URL/$path" --max-time 5)
  [[ "$code" == "200" || "$code" == "403" ]] && echo "[$code] $path" | tee -a recon/http/disclosure-files.txt
done
```

## Phase 5 — Authentication surface mapping

```bash
for path in /login /signin /admin /administrator /dashboard /panel /wp-admin \
  /api/login /api/auth /api/v1/auth /oauth/authorize /oauth/token /saml/login /sso \
  /register /signup /forgot-password /reset-password; do
  code=$(curl -so /dev/null -w "%{http_code}" -L "$URL$path" --max-time 5)
  [[ "$code" != "404" && "$code" != "000" ]] && echo "[$code] $path" | tee -a recon/http/auth-endpoints.txt
done
```

## Phase 6 — Content discovery

```bash
ffuf -u "$URL/FUZZ" \
  -w ~/SecLists/Discovery/Web-Content/raft-large-directories.txt \
  -mc 200,201,204,301,302,307,401,403 -fc 404 \
  -o recon/http/dirs.json -of json -t 40 -rate 100

ffuf -u "$URL/FUZZ" \
  -w ~/SecLists/Discovery/Web-Content/api/api-endpoints.txt \
  -mc 200,201,204,301,302,401,403 \
  -o recon/http/api-endpoints.json -of json -t 40

# Backup file discovery
ffuf -u "$URL/FUZZ" \
  -w ~/SecLists/Discovery/Web-Content/raft-large-files.txt \
  -e .bak,.backup,.old,.orig,.copy,.tmp,.swp,.gz,.tar,.zip,.sql,.dump \
  -mc 200 -o recon/http/backups.json -of json
```

## Phase 7 — JavaScript and API analysis

```bash
katana -u $URL -jc -kf all -d 5 -o recon/http/katana-urls.txt -silent

# Download and analyze JS files
mkdir -p recon/js
for jsurl in $(cat recon/http/katana-urls.txt | grep "\.js$" | sort -u | head -50); do
  filename=$(echo $jsurl | md5sum | cut -d' ' -f1)
  curl -sL "$jsurl" -o "recon/js/$filename.js"
done

# Extract endpoints and secrets from JS
grep -ohP "(https?://[^\s\"']+|/[a-zA-Z0-9_\-/]+)" recon/js/*.js 2>/dev/null \
  | sort -u | tee recon/js/js-endpoints.txt
grep -ohiP "(api[_-]?key|secret|token|password|auth|bearer|aws|stripe)\s*[=:]\s*['\"][^'\"]{8,}['\"]" \
  recon/js/*.js 2>/dev/null | tee recon/loot/js-secrets.txt

# GraphQL detection
for gqlpath in /graphql /graphiql /api/graphql /v1/graphql /gql; do
  code=$(curl -so /dev/null -w "%{http_code}" -X POST "$URL$gqlpath" \
    -H "Content-Type: application/json" -d '{"query":"{__typename}"}')
  [[ "$code" == "200" ]] && echo "[!] GraphQL: $gqlpath" | tee -a recon/http/graphql.txt
done
```

## Phase 8 — Parameter discovery

```bash
cat recon/osint/wayback-urls.txt recon/http/katana-urls.txt 2>/dev/null \
  | grep "?" | grep -oP "\?.*" | tr '&' '\n' | cut -d'=' -f1 | tr -d '?' \
  | sort -u | tee recon/http/parameters.txt
```

## Phase 9 — Target profile output

Write `recon/target-profile.md` with: infrastructure (IP, ASN, CDN, WAF, load balancer), subdomains (live), technology stack, open ports/services, authentication endpoints, interesting endpoints, sensitive files, secrets/credentials found, security headers, and ranked attack surface summary.

## Rules
- Save all raw output to workspace immediately
- Record every 200, 403, and 401 — 403 means the path exists
- Negative results are findings — document them
- After each phase emit a one-line summary
- Do not begin exploitation during recon — complete the profile first
- If WAF detected, note it and plan bypass approach before proceeding
