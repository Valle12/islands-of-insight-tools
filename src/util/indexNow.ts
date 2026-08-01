/**
 * Submits every page to IndexNow — the one automatic "please recrawl" that
 * actually exists for a site like this.
 *
 * Google is deliberately not in the picture: its Indexing API accepts only
 * JobPosting and BroadcastEvent and ignores everything else, and it has never
 * adopted IndexNow. Google discovers changes through `sitemap.xml` instead,
 * which it re-fetches on its own once the sitemap has been submitted in Search
 * Console. This covers Bing, Yandex, Seznam and Naver, which share one
 * endpoint.
 *
 * Run by `deploy.yml` after the Pages deployment goes live — the URLs have to
 * be fetchable when they are submitted.
 */
import { canonicalUrl, INDEXNOW_KEY, PAGES, SITE_URL } from "./siteMeta";

const ENDPOINT = "https://api.indexnow.org/indexnow";

const body = {
  host: new URL(SITE_URL).host,
  key: INDEXNOW_KEY,
  // Without this the key file would have to sit at the host root, which a
  // GitHub Pages PROJECT site does not own. Pointing at the copy under the
  // subpath is what lets the key vouch for the urls beneath it — and it also
  // limits what this key can ever be used to submit, which is the point.
  keyLocation: `${SITE_URL}${INDEXNOW_KEY}.txt`,
  urlList: PAGES.map(canonicalUrl),
};

console.log(`Submitting ${body.urlList.length} urls to IndexNow:`);
for (const url of body.urlList) console.log(`  ${url}`);

const response = await fetch(ENDPOINT, {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify(body),
});

// 200 accepted, 202 accepted with the key still to be verified. Everything
// else is worth failing on so the deploy log says so — the workflow step is
// `continue-on-error`, so a rejected submission never blocks a release.
const text = await response.text();
console.log(`${response.status} ${response.statusText} ${text}`.trim());
if (!response.ok) {
  throw new Error(`IndexNow rejected the submission (${response.status})`);
}
