<?php
/**
 * Plugin Name: CU Blog Meta Bridge
 * Description: Lets the Christian Unified Blog Builder set Yoast SEO fields (meta description, focus keyword) when it publishes a post via the WordPress REST API. One tiny file, no settings, no UI.
 * Version: 1.0
 * Author: Christian Unified Schools of San Diego
 */

if (!defined('ABSPATH')) exit;

add_action('init', function () {
    foreach (['_yoast_wpseo_metadesc', '_yoast_wpseo_focuskw', '_yoast_wpseo_title'] as $key) {
        register_post_meta('post', $key, [
            'show_in_rest'  => true,
            'single'        => true,
            'type'          => 'string',
            'auth_callback' => function () {
                return current_user_can('edit_posts');
            },
        ]);
    }
});
