# Christian Unified Blog Builder

The Amy Gray Photography blog builder, pointed at **christianunified.org**.

Whoever writes the school blog opens one link, drags in the photos from an event,
builds rows (singles / diptychs / triptychs), pastes the write-up, presses ✨ for
AI-written SEO (titles, meta description, alt text, internal + external links),
and clicks **Publish** — the post goes live on christianunified.org with real
HTML, photos uploaded to the WordPress media library, and BlogPosting schema.

## Why this exists

The school's blog has exactly the same problem the photography blog had. Every
post on christianunified.org today — Homecoming 2025, the Veterans Day
celebration, the spring musical — is this, and nothing else:

```html
<div class="StorytailorBlog" id="StorytailorBlog" data-x="14383" data-y="36472"></div>
<p><script src="https://bs4.stompsoftware.com/blog/content.js"></script></p>
```

The words and photos live on stompsoftware.com and load in with JavaScript, so
Google and the AI crawlers see an empty box. This app writes the actual text,
images, alt text, links and JSON-LD schema **into the WordPress post itself**.

## What's the same as the AGP builder

Everything: drafts auto-save in the browser, swapping a photo is one click,
publishing is resumable, photos are resized to 1800px in the browser, credit and
copyright are stamped into each JPEG's XMP, and there's a live 8-point SEO
scorecard against the focus keyword.

## Draft the opening from a flyer

Step 3 has a **source material** box. Drop in the event's flyer, program, press
release or email — a PDF, or photos of it — and press **✍️ Draft the opening from
it**. Claude reads the documents and drafts the opening paragraph (what, when,
where, who, why), shows the facts it pulled out, and adds the paragraph as the first
block of the post with one click. If the title or campus field is still empty it
fills those in too, and the facts ride along to the ✨ button so titles and meta
descriptions agree with the flyer.

The documents are source material only: they live in memory, are never saved with
the draft, and are never published. Photos of a flyer are shrunk to 1600px before
upload; PDFs go as-is (keep them under 15 MB, ~20 MB total).

## What's different

| | AGP builder | This one |
|---|---|---|
| Site | amygrayphotography.com | christianunified.org |
| Backend routes | `/api/blog/*` | `/api/cu/blog/*` (same server) |
| Passphrase header | `X-AGP-Key` | `X-CU-Key` |
| Photo credit | always Amy Gray Photography | **editable per post**, defaults to the school |
| Keywords | family-photography terms | school-search terms parents actually type |
| AI briefing | photo session, "Location Photos \| Hook" titles | school life, "Hook: Event Year" titles, campus names, Patriots, never invents student names |
| End-of-post CTA | "Let's plan your session" | "Schedule a campus tour" |
| Schema author | Amy Gray (Person) | the school (Organization) |
| Design file | `.agpblog.json` | `.cublog.json` |

Two fixes went in here that also improve the AGP app, since the backend is shared:

- The site fetch **paginates**. christianunified.org has 263 pages; a single
  `per_page=100` call was hiding Campus Tours and Admission — the two pages the
  link picker most wants.
- The link picker **ranks reader-facing pages above staff/parent forms**, so you
  see Campus Tours and Athletics instead of permission slips and absence reports.

## Pieces

| Piece | Where |
|---|---|
| Frontend (this folder) | GitHub Pages → `github.com/amycothrangray/cu-blog-builder` |
| Backend routes | `agp-wallart-backend/server.js` (DigitalOcean "dolphin-app") — same server as the AGP builder |
| WP plugin | `wp-plugin/cu-blog-bridge.php` — **required.** How the app authenticates and publishes |

## How it authenticates (and why it differs from the AGP app)

The AGP builder logs into WordPress with an **application password**. That route
is closed on christianunified.org: **Wordfence disables application passwords**
site-wide (Wordfence → Firewall → Firewall Options → *Disable WordPress
application passwords*), and its options screen is itself locked behind an
incomplete Wordfence license install.

Rather than weaken the school's firewall, this app ships its own door. The
`cu-blog-bridge` plugin adds two routes — `POST /wp-json/cu-blog/v1/media` and
`POST /wp-json/cu-blog/v1/publish` — guarded by a shared secret the plugin
generates for you. Nothing about Wordfence changes.

- The secret is compared with `hash_equals()` (constant time) and the routes
  refuse to answer over plain HTTP.
- Uploads are checked with `getimagesizefromstring()` — the bytes must really be
  a JPEG, PNG or WebP, whatever the filename claims.
- Posts are written as a WordPress user you pick, and the plugin switches to that
  user before inserting. That matters: without it WordPress strips the
  BlogPosting JSON-LD `<script>`, which is the whole point of the app.
- Reads (categories, pages, posts for the link picker) need no login at all —
  that data is already public.
- Regenerating the secret from the settings screen instantly revokes the old one.

## One-time setup

**1 — Install the bridge plugin** (on christianunified.org)

Zip `wp-plugin/cu-blog-bridge.php` (or use the `cu-blog-bridge.zip` in this
folder) → wp-admin → **Plugins → Add New → Upload Plugin** → Activate.
Then go to **Settings → CU Blog Bridge** and copy the shared secret it generated.
Check the "Posts are written by" dropdown while you're there.

**2 — Backend**

Upload the updated `server.js` to `github.com/amycothrangray/agp-wallart-backend`
via the web uploader. It auto-deploys to DigitalOcean. The AGP routes are
unchanged — same paths, same env vars, same behaviour.

**3 — DigitalOcean env vars** (dolphin-app → Settings → **component** `agp-wallart-backend`
→ Environment Variables → Edit)

Note: the app-level list is empty — every existing variable lives on the component,
so the new ones go there too. Tick **Encrypt** on both.

Add these. Nothing existing changes — the AGP variables and routes are untouched.

| Variable | Value |
|---|---|
| `CU_BLOG_APP_KEY` | a passphrase you make up — give it to whoever writes the blog (encrypt) |
| `CU_BRIDGE_SECRET` | the secret from Settings → CU Blog Bridge in step 1 (encrypt) |
| `CU_WP_URL` | *optional* — defaults to `https://christianunified.org` |

There is deliberately no WordPress username or password here. The bridge is the
only credential, it only does two things, and you can revoke it in one click.

`ANTHROPIC_API_KEY` is already set and is shared by both apps.

**4 — GitHub Pages**

Create a public repo `cu-blog-builder`, upload `index.html`, `style.css`,
`app.js`, `README.md` via the web uploader, then Settings → Pages → deploy from
branch, `main` / root.

App URL: `https://amycothrangray.github.io/cu-blog-builder/`

## Publishing app updates

Same drill as the other apps: edit locally, bump `?v=N` on the css/js links in
`index.html`, upload the changed files via the GitHub web uploader.

## Notes

- **Posts go live immediately** (status `publish`), same as the AGP app. If the
  school ever wants a review step, it's a one-line change: in `app.js`, the
  publish call sends `status: 'publish'` — change it to `'draft'` and posts land
  in wp-admin for someone to approve.
- The site's categories (Blog, Chapel, Arts, Athletics, Teacher Bios) load
  automatically — nothing to configure.
- Photos are resized to 1800px long edge, JPEG q0.82, in the browser before upload.
- Publishing is resumable: if it fails mid-way, press Publish again and photos
  already uploaded are skipped.
- The backend endpoints require the `X-CU-Key` header; without `CU_BLOG_APP_KEY`
  set they return 503. (DigitalOcean's edge rewrites that 503 into its own
  branded error page reporting 504 — that is what "not configured yet" looks
  like from outside.)
- Yoast meta description and focus keyword are set by the bridge directly; Yoast
  is already installed on the site.
