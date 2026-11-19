---
'@swirls/shuttle': minor
---

Markdown in the conversation, pull requests and reviews is rendered with `@pierre/words` instead of `react-markdown`. While a reply streams, unfinished bold, code and links show as they will end up, new text fades in, and the caret follows the text into lists and code blocks. Code blocks are highlighted with `@pierre/highlights` in the diff viewer's theme and have a Copy button. `theme.css` styles the markdown through its `data-markdown` elements, and the `.caret` class is gone. `@pierre/diffs` moves to 1.7.0-beta.4, the release that shares `@pierre/highlights` 0.5.1.
