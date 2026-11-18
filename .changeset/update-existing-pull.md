---
'@swirls/shuttle': patch
---

The publish card says when it will push to a pull request the layer already has: it is titled
"Update owner/repo#13", links to that pull request, and offers "Push update" instead of
"Publish as draft" and "Publish", which did nothing different for an existing pull request.
After publishing it says "Updated #13" rather than "Opened 1 pull request". `PublishedPull`
gains an optional `outcome` (`opened`, `updated` or `unchanged`).
