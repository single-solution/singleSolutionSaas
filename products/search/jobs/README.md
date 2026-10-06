# Jobs

None. Site Search runs no scheduled jobs, timers or background loops:

- crawls run when the merchant asks (dashboard **Crawl now** / **Crawl due sources**, or `POST /v1/sources/{key}/crawl`),
  step after step within a time budget, and a run cut short is continued by the next request; a Catalog item event
  re-crawls the item's page where a sitemap source indexed it;
- the Atlas Search index state is probed when a search needs it (cached 10 minutes) or by the dashboard's re-check;
- unused vocabulary terms are removed in the write that removed their last use.
