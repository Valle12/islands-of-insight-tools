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

/**
 * The endpoint's documented status vocabulary.
 *
 * The log prints OUR words for a code rather than echoing the response body or
 * its status text. Both are remote input, and a newline inside either would
 * forge a second line in the deploy log (Sonar S5145). It also says more than
 * the body does: on success there is no body at all.
 */
const MEANINGS: Record<number, string> = {
  200: "accepted",
  202: "accepted, key validation still pending",
  400: "bad request",
  403: "the key is not valid for this host",
  422: "the urls do not belong to the host, or the key does not match",
  429: "too many requests",
};

// 200 and 202 are both successes. Anything else is worth failing on so the
// deploy log says so — the workflow step is `continue-on-error`, so a rejected
// submission never blocks a release.
console.log(
  `IndexNow responded ${response.status}: ${MEANINGS[response.status] ?? "unrecognized status"}`,
);
if (!response.ok) {
  throw new Error(`IndexNow rejected the submission (${response.status})`);
}
