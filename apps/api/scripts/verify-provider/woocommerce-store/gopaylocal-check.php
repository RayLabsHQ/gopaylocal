<?php
/**
 * Plugin Name: GoPayLocal store check
 * Description: Lets the throwaway store in apps/api/scripts/verify-provider/woocommerce-store deliver webhooks to the receiver on the same machine. Never install this on a real store.
 *
 * WordPress refuses to send requests to private addresses and to servers whose
 * certificate it cannot verify. The webhook receiver of the check is both: it
 * listens on the machine that runs the store, behind a certificate made for
 * that one run. These two filters allow exactly that, and only for the
 * receiver's host name.
 */

const GOPAYLOCAL_CHECK_HOOK_HOST = 'hook.example.com';

add_filter(
	'http_request_host_is_external',
	static function ( $external, $host ) {
		return GOPAYLOCAL_CHECK_HOOK_HOST === $host ? true : $external;
	},
	10,
	2
);

add_filter(
	'https_ssl_verify',
	static function ( $verify, $url ) {
		return GOPAYLOCAL_CHECK_HOOK_HOST === wp_parse_url( (string) $url, PHP_URL_HOST ) ? false : $verify;
	},
	10,
	2
);
