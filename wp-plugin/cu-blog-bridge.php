<?php
/**
 * Plugin Name: CU Blog Bridge
 * Description: Lets the Christian Unified Blog Builder upload photos and publish posts without WordPress application passwords, which Wordfence disables on this site. Adds two REST routes under cu-blog/v1, guarded by a shared secret this plugin generates for you. See Settings → CU Blog Bridge for the secret to paste into the app's backend.
 * Version: 1.2
 * Author: Christian Unified Schools of San Diego
 */

if (!defined('ABSPATH')) exit;

define('CU_BLOG_BRIDGE_SECRET_OPT', 'cu_blog_bridge_secret');
define('CU_BLOG_BRIDGE_AUTHOR_OPT', 'cu_blog_bridge_author');
define('CU_BLOG_BRIDGE_HEADER', 'x-cu-bridge-secret');

/* ------------------------------------------------------------- activation */

register_activation_hook(__FILE__, function () {
    if (!get_option(CU_BLOG_BRIDGE_SECRET_OPT)) {
        add_option(CU_BLOG_BRIDGE_SECRET_OPT, wp_generate_password(48, false, false));
    }
    if (!get_option(CU_BLOG_BRIDGE_AUTHOR_OPT)) {
        add_option(CU_BLOG_BRIDGE_AUTHOR_OPT, get_current_user_id());
    }
});

/* ------------------------------------------------------------------ auth */

/**
 * The only gate on these routes. Constant-time compare so the secret can't be
 * guessed a character at a time, and HTTPS-only so it never crosses in clear.
 */
function cu_blog_bridge_auth(WP_REST_Request $req) {
    if (!is_ssl()) {
        return new WP_Error('cu_insecure', 'HTTPS required.', ['status' => 403]);
    }
    $secret = (string) get_option(CU_BLOG_BRIDGE_SECRET_OPT);
    if ($secret === '') {
        return new WP_Error('cu_unconfigured', 'Bridge has no secret set.', ['status' => 503]);
    }
    $given = (string) $req->get_header(CU_BLOG_BRIDGE_HEADER);
    if ($given === '' || !hash_equals($secret, $given)) {
        return new WP_Error('cu_forbidden', 'Bad or missing bridge secret.', ['status' => 401]);
    }
    return true;
}

/** The WordPress user posts are attributed to, and whose capabilities apply. */
function cu_blog_bridge_author_id() {
    $id = (int) get_option(CU_BLOG_BRIDGE_AUTHOR_OPT);
    if ($id && get_userdata($id)) return $id;
    $admins = get_users(['role' => 'administrator', 'number' => 1, 'fields' => 'ID']);
    return $admins ? (int) $admins[0] : 0;
}

/**
 * Act as the configured author for the rest of the request. This matters for
 * more than attribution: wp_insert_post() runs the content through kses unless
 * the current user has unfiltered_html, which would strip the BlogPosting
 * JSON-LD <script> the app embeds for SEO — the whole point of the app.
 */
function cu_blog_bridge_become_author() {
    $id = cu_blog_bridge_author_id();
    if ($id) wp_set_current_user($id);
    return $id;
}

/* ---------------------------------------------------------------- routes */

add_action('rest_api_init', function () {
    $guard = ['permission_callback' => 'cu_blog_bridge_auth'];

    register_rest_route('cu-blog/v1', '/ping', array_merge($guard, [
        'methods'  => 'GET',
        'callback' => function () {
            return [
                'ok'     => true,
                'author' => cu_blog_bridge_author_id(),
                'yoast'  => defined('WPSEO_VERSION'),
                'tz'     => wp_timezone_string(),
                'now'    => current_time('mysql'),
            ];
        },
    ]));

    register_rest_route('cu-blog/v1', '/media', array_merge($guard, [
        'methods'  => 'POST',
        'callback' => 'cu_blog_bridge_media',
    ]));

    register_rest_route('cu-blog/v1', '/publish', array_merge($guard, [
        'methods'  => 'POST',
        'callback' => 'cu_blog_bridge_publish',
    ]));
});

/* ----------------------------------------------------------------- media */

function cu_blog_bridge_media(WP_REST_Request $req) {
    cu_blog_bridge_become_author();
    $p = (array) $req->get_json_params();

    $filename = sanitize_file_name((string) ($p['filename'] ?? 'photo.jpg'));
    if ($filename === '') $filename = 'photo.jpg';

    $data = base64_decode((string) ($p['dataBase64'] ?? ''), true);
    if ($data === false || strlen($data) < 100) {
        return new WP_Error('cu_bad_file', 'Missing or unreadable image data.', ['status' => 400]);
    }
    if (strlen($data) > 12000000) {
        return new WP_Error('cu_big_file', 'Image too large.', ['status' => 413]);
    }
    // Trust nothing about the extension — confirm the bytes really are an image.
    $info = @getimagesizefromstring($data);
    $allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!$info || !isset($info['mime']) || !in_array($info['mime'], $allowed, true)) {
        return new WP_Error('cu_not_image', 'That file is not a JPEG, PNG or WebP.', ['status' => 400]);
    }

    $up = wp_upload_bits($filename, null, $data);
    if (!empty($up['error'])) {
        return new WP_Error('cu_upload_failed', $up['error'], ['status' => 500]);
    }

    $id = wp_insert_attachment([
        'post_mime_type' => $info['mime'],
        'post_title'     => sanitize_text_field((string) ($p['title'] ?? $filename)),
        'post_content'   => sanitize_textarea_field((string) ($p['description'] ?? '')),
        'post_excerpt'   => sanitize_text_field((string) ($p['caption'] ?? '')),
        'post_status'    => 'inherit',
    ], $up['file']);
    if (is_wp_error($id)) return $id;

    require_once ABSPATH . 'wp-admin/includes/image.php';
    wp_update_attachment_metadata($id, wp_generate_attachment_metadata($id, $up['file']));

    $alt = sanitize_text_field((string) ($p['alt'] ?? ''));
    if ($alt !== '') update_post_meta($id, '_wp_attachment_image_alt', $alt);

    return ['id' => (int) $id, 'url' => wp_get_attachment_url($id)];
}

/* --------------------------------------------------------------- publish */

function cu_blog_bridge_publish(WP_REST_Request $req) {
    $author = cu_blog_bridge_become_author();
    $p = (array) $req->get_json_params();

    $title   = sanitize_text_field((string) ($p['title'] ?? ''));
    $content = (string) ($p['contentHtml'] ?? '');
    if ($title === '' || $content === '') {
        return new WP_Error('cu_missing', 'Missing title or content.', ['status' => 400]);
    }

    $post = [
        'post_type'    => 'post',
        'post_title'   => $title,
        'post_content' => $content,
        'post_excerpt' => sanitize_text_field((string) ($p['excerpt'] ?? '')),
        'post_status'  => (($p['status'] ?? 'publish') === 'draft') ? 'draft' : 'publish',
        'post_author'  => $author,
    ];

    /* Scheduling and back-dating. The app sends a plain local time
       ("2026-09-04T18:30:00") meant in the site's own timezone, so set
       post_date and let WordPress derive the GMT value. A future date must
       also flip the status to 'future', otherwise WordPress publishes it
       straight away with tomorrow's date printed on it. */
    $date = (string) ($p['date'] ?? '');
    if ($date !== '' && preg_match('/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/', $date)) {
        $local = str_replace('T', ' ', $date);
        if (strlen($local) === 16) $local .= ':00';
        $post['post_date']     = $local;
        $post['post_date_gmt'] = get_gmt_from_date($local);
        if ($post['post_status'] === 'publish'
            && strtotime($local) > strtotime(current_time('mysql'))) {
            $post['post_status'] = 'future';
        }
    }
    $slug = sanitize_title((string) ($p['slug'] ?? ''));
    if ($slug !== '') $post['post_name'] = $slug;
    if (!empty($p['categories']) && is_array($p['categories'])) {
        $post['post_category'] = array_values(array_filter(array_map('intval', $p['categories'])));
    }

    /* Publishing the same draft twice used to make two posts, so fixing a typo
       meant either editing in wp-admin or trashing the first one. The app now
       remembers the post it made and sends its id back; when that post still
       exists, this becomes an update in place. The date is left alone on an
       update unless the app explicitly sent one. */
    $postId   = (int) ($p['postId'] ?? 0);
    $existing = $postId ? get_post($postId) : null;
    $updating = $existing && $existing->post_type === 'post' && $existing->post_status !== 'trash';
    if ($updating) {
        $post['ID'] = $postId;
        $id = wp_update_post($post, true);
    } else {
        $id = wp_insert_post($post, true);
    }
    if (is_wp_error($id)) return $id;

    $featured = (int) ($p['featuredMediaId'] ?? 0);
    if ($featured && get_post($featured)) set_post_thumbnail($id, $featured);

    $yoast = false;
    $desc = sanitize_text_field((string) ($p['metaDesc'] ?? ''));
    if ($desc !== '') { update_post_meta($id, '_yoast_wpseo_metadesc', $desc); $yoast = true; }
    $kw = sanitize_text_field((string) ($p['focusKeyword'] ?? ''));
    if ($kw !== '') { update_post_meta($id, '_yoast_wpseo_focuskw', $kw); $yoast = true; }

    return [
        'id'               => (int) $id,
        'link'             => get_permalink($id),
        'updated'          => (bool) $updating,
        'yoastMetaApplied' => $yoast,
        'status'           => get_post_status($id),
        'date'             => get_post_field('post_date', $id),
    ];
}

/* -------------------------------------------------------- settings screen */

add_action('admin_menu', function () {
    add_options_page('CU Blog Bridge', 'CU Blog Bridge', 'manage_options',
        'cu-blog-bridge', 'cu_blog_bridge_settings_page');
});

function cu_blog_bridge_settings_page() {
    if (!current_user_can('manage_options')) return;

    if (isset($_POST['cu_blog_bridge_nonce']) &&
        wp_verify_nonce(sanitize_key($_POST['cu_blog_bridge_nonce']), 'cu_blog_bridge_save')) {
        if (isset($_POST['cu_regenerate'])) {
            update_option(CU_BLOG_BRIDGE_SECRET_OPT, wp_generate_password(48, false, false));
            echo '<div class="notice notice-warning"><p>New secret generated. Paste it into the app backend — the old one stops working now.</p></div>';
        }
        if (isset($_POST['cu_author'])) {
            update_option(CU_BLOG_BRIDGE_AUTHOR_OPT, (int) $_POST['cu_author']);
            echo '<div class="notice notice-success"><p>Author updated.</p></div>';
        }
    }

    $secret = (string) get_option(CU_BLOG_BRIDGE_SECRET_OPT);
    $author = cu_blog_bridge_author_id();
    ?>
    <div class="wrap">
      <h1>CU Blog Bridge</h1>
      <p>The Blog Builder app publishes through these two routes instead of an
         application password, because Wordfence disables application passwords
         on this site.</p>
      <form method="post">
        <?php wp_nonce_field('cu_blog_bridge_save', 'cu_blog_bridge_nonce'); ?>
        <table class="form-table" role="presentation">
          <tr>
            <th scope="row"><label for="cu-secret">Shared secret</label></th>
            <td>
              <input id="cu-secret" type="text" readonly class="large-text code"
                     value="<?php echo esc_attr($secret); ?>"
                     onclick="this.select()">
              <p class="description">
                Paste this into DigitalOcean as <code>CU_BRIDGE_SECRET</code>.
                Treat it like a password — anyone holding it can post to this site.
              </p>
              <p><button type="submit" name="cu_regenerate" value="1" class="button"
                         onclick="return confirm('Generate a new secret? The app stops publishing until you paste the new one into DigitalOcean.')">
                Regenerate secret</button></p>
            </td>
          </tr>
          <tr>
            <th scope="row"><label for="cu-author">Posts are written by</label></th>
            <td>
              <?php wp_dropdown_users([
                  'name'     => 'cu_author',
                  'id'       => 'cu-author',
                  'selected' => $author,
                  'role__in' => ['administrator', 'editor', 'author'],
              ]); ?>
              <p class="description">Published posts are attributed to this user.</p>
              <p><button type="submit" class="button button-primary">Save author</button></p>
            </td>
          </tr>
        </table>
      </form>
    </div>
    <?php
}
