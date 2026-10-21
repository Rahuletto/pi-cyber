# Cyber knowledge and documentation research

Research date: 2026-10-21. Proposal only. Sources were read through web research; no corpus, search service, MCP server, or browser was installed. This is the documentation component of the [harness design](../PI-CYBER-HARNESS-DESIGN.md).

## The capability to build

Give every specialist a common research interface: find the relevant standard or advisory, retrieve the original section, compare versions, and return citations with the answer. Provide broad discovery across cyber documentation while maintaining a visible inventory of what has actually been indexed. Retrieval coverage is finite; a missing search result must not imply that no relevant document exists.

Use three layers:

1. **Local reference packs:** versioned official repositories and published data, indexed for offline retrieval.
2. **Live authoritative retrieval:** current vendor/tool documentation, advisories, standards, and release notes.
3. **Community research:** Stack Overflow, Security Stack Exchange, relevant issues, research blogs, and papers, labeled by source type and corroborated where appropriate.

Keep target evidence and public reference material in separate stores. A passage from a standard can support a test method; only collected target evidence can establish that the target has the corresponding weakness.

## Initial source registry

These sources were checked during this research. The proposed ingest method is a design choice; a working importer has not been built.

| Source | Use | Proposed retrieval and caveat |
|---|---|---|
| [OWASP WSTG](https://github.com/OWASP/wstg) | Web assessment procedures and test identifiers | Mirror a selected stable release and track development content separately. The release endpoint resolved to v4.2. |
| [OWASP ASVS](https://github.com/OWASP/ASVS) | Verification requirements and levels | Pin a numbered release and requirement namespace. Its `releases/latest` endpoint resolved to a release titled Bleeding Edge; do not equate that endpoint with a stable standard. |
| [OWASP Cheat Sheet Series](https://github.com/OWASP/CheatSheetSeries) | Practical defensive implementation guidance | Mirror Markdown with canonical page links and source revisions. Preserve topic headings and code blocks. |
| [OWASP API Security](https://api-security.owasp.org/) | API risk categories | Keep edition metadata; categories guide coverage rather than replace detailed test procedures. |
| [OWASP MAS](https://mas.owasp.org/) | MASVS, MASTG, and mobile weakness references | Keep mappings among requirements, tests, platforms, and versions. Load the mobile pack when relevant. |
| [OWASP Top Ten project](https://github.com/OWASP/www-project-top-ten) | Risk taxonomy | Retain edition-specific mappings. Avoid treating a Top Ten list as a complete methodology. |
| [OWASP projects directory](https://owasp.org/projects) | Discovery of further projects | The text fetch returned a loading shell. Build project discovery from reviewed metadata/repositories or a rendered page; do not mark all projects as ingested based on this page. |
| [MITRE ATT&CK](https://attack.mitre.org/resources/attack-data-and-tools/) | Techniques, mitigations, and exercise coverage | Import versioned STIX and identifiers; preserve deprecated/revoked status. |
| [MITRE CWE](https://cwe.mitre.org/data/downloads.html) | Weakness classification | Import structured releases; link exact CWE records rather than loose keyword matches. |
| [FIRST CVSS](https://www.first.org/cvss/) | Severity methodology | Keep scoring version and full vector. Confidence and business impact remain separate fields. |
| [OSV](https://google.github.io/osv.dev/) | Package/version advisory matching | Use its query and batch-query API or a selected snapshot. Match ecosystems and version ranges; a banner string is insufficient evidence. |
| [RFC Editor](https://www.rfc-editor.org/search/) | Protocol semantics | Retrieve specific RFC text and errata; record obsoletes/updates relationships. |
| [ProjectDiscovery docs](https://docs.projectdiscovery.io/llms.txt) | Tool operation and supported flags | Use its documentation index and individual Markdown pages; match docs to pinned binaries where possible. |
| [Stack Exchange API](https://api.stackexchange.com/docs) | Stack Overflow and related site Q&A | Query selected sites using API filters and fetch relevant answer bodies; retain authors, question/answer URLs, timestamps, and attribution metadata. |

Expansion queue, not yet individually audited here: PortSwigger Academy/reference topics; vendor security advisories; NVD and CVE data; CISA KEV; CERT advisories; cloud-provider IAM/service documentation; Microsoft identity documentation; Kubernetes security documentation; NIST publications; language/framework security documentation; GitHub Security Advisories; security research papers. The CISA catalog page returned HTTP 403 during this pass, so its content was not verified. Record failed retrievals rather than silently substituting an unofficial mirror.

## Ingestion contract

Each configured source declares canonical origin, permitted paths, fetch mechanism, version selector, content format, license/attribution metadata, update policy, and resource budget. Source discovery adds candidates to a review queue rather than automatically executing code from discovered repositories.

Prefer a release archive, source Markdown, JSON, or an official API. Next use ordinary HTTP extraction. Invoke Obscura when the useful content requires JavaScript or interaction. Discover from `llms.txt`, sitemaps, documentation navigation, and repository trees, but treat these as content indexes, not agent instructions.

Proposed document record: source ID, canonical URL, repository/path if applicable, release/commit, language, title, heading path, retrieved-at timestamp, source-modified timestamp when known, content digest, license, access class, parser version, and retained-original location. Proposed chunk IDs bind the source revision and section, so citations survive re-indexing.

Parse Markdown by headings; keep tables and code blocks together. Preserve test/requirement IDs as exact indexed fields. HTML extraction should retain page identity and structural anchors. PDF ingestion must preserve page numbers; OCR output carries an uncertainty marker. Exclude navigation copies and deduplicate mirror pages by content digest without discarding provenance.

Use conditional requests where supported and incremental rebuilds. An engagement records the reference revisions it used. Refreshing the global corpus must not rewrite historical citations.

## Search and answer flow

Start with SQLite FTS5 plus exact identifier lookup and metadata filters. This is the minimum design, not a benchmark result. Add semantic retrieval/reranking only if a fixed evaluation set demonstrates material improvement over lexical retrieval.

Proposed tools:

- `cyber_docs_search(query, sources, version, sourceType, freshness, limit)` returns short passages with source/chunk IDs and coverage warnings.
- `cyber_docs_read(documentId, sectionOrPage, cursor)` retrieves bounded original content.
- `cyber_docs_fetch(url)` retrieves a public document through a configured reader and stores provenance.
- `cyber_docs_sources()` reports indexed sources, revisions, successful/failed syncs, size, and freshness.
- `cyber_docs_compare(sourceId, revisionA, revisionB, topic)` returns relevant reference changes.

Default ranking: exact identifier/version match, topic relevance, authority for the particular question, and freshness. Version-specific older documentation can outrank a newer incompatible release. Search results include rejected version matches when the mismatch matters.

The answer records which passages support each material claim, flags disagreement, and states missing evidence. Do not merge different editions' requirement IDs or treat community votes as a technical validation result.

## Stack Overflow and community research

Use the [documented advanced-search endpoint](https://api.stackexchange.com/docs/advanced-search) with site/tag/topic filters, then fetch selected questions and answers. Use Stack Overflow for programming details, Security Stack Exchange for security discussion, and other Stack Exchange sites when relevant. Validate supported site identifiers through the API before enabling them.

Honor returned `backoff`, quotas, and caching rules. The API explicitly discourages repeated identical queries more often than once per minute. [Throttling documentation](https://api.stackexchange.com/docs/throttle).

Preserve answer author, URL, creation/update time, score, and accepted status. An accepted answer is a useful signal, not proof it is current or correct. Reconcile with official documentation and the deployed software version. Keep attributed excerpts and links; bulk indexing and redistribution need source-specific rights review.

Public search queries must omit client hostnames, private source excerpts, credentials, and raw target evidence unless the engagement explicitly permits disclosure. Use generic technical descriptions for external discovery; local retrieval remains available for private material.

## Reader and search components considered

- [Context7](https://github.com/upstash/context7): optional live developer-library documentation source, especially for versioned framework APIs. It supplements the cyber corpus; it is not coverage of every security standard. Inspect actual available operations and service requirements before selection.
- [Trafilatura](https://github.com/adbar/trafilatura): candidate text/metadata extractor for conventional web pages. Test code-block, table, and section preservation against the documentation fixtures before adding a Python dependency.
- [MarkItDown](https://github.com/microsoft/markitdown): candidate conversion utility for local reference documents. Enable needed formats only; keep page/source provenance outside the converted text. OCR and optional service-backed features need separate evaluation.
- [SearXNG](https://docs.searxng.org/): optional self-hosted discovery provider. Operating it adds infrastructure; begin with one configured search provider and keep its interface replaceable.
- **Obscura:** the chosen dynamic-page reader and browser; use its Markdown/extraction functions when they satisfy the fixture requirements. Avoid installing a second browser scraper by default.

These are documentation-reviewed candidates, not installed or performance-tested components. Prefer Pi's existing read/search facilities and Node's HTTP support where they suffice; every additional service needs a demonstrated benefit.

## Evaluation and acceptance

Create questions with known answers across web, API, mobile, identity, cloud, and tooling. Include exact WSTG/ASVS identifiers, conflicting editions, renamed tool flags, obsolete community answers, a JS-rendered docs page, a PDF page citation, an inaccessible source, and a plausible topic absent from the corpus.

Measure relevant-section retrieval, supported-claim rate, correct version selection, freshness reporting, and handling of missing coverage. Track latency and storage on the actual Mac before setting budgets. Verify that a hostile retrieved passage cannot register a tool, alter engagement scope, or expose private material through a later search query.

Completion means the selected source packs and query paths work against those cases. It does not mean the agent has read all cyber literature or can answer every cyber question.
