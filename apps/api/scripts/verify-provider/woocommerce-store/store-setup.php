<?php
/**
 * Sets up the throwaway store for run.sh, through WP-CLI:
 *
 *   wp eval-file /gopaylocal-check/store-setup.php
 *
 * It opens the shop to visitors, turns on Cash on delivery (an order placed
 * with it becomes Processing, which is a paid status, with no payment
 * provider involved), creates one product and one REST API key, and prints
 * them as one line of JSON.
 */

if ( ! class_exists( 'WooCommerce' ) ) {
	fwrite( STDERR, "WooCommerce is not active\n" );
	exit( 1 );
}

WC_Install::create_pages();

update_option( 'woocommerce_coming_soon', 'no' );
update_option( 'woocommerce_store_pages_only', 'no' );
update_option( 'woocommerce_enable_guest_checkout', 'yes' );
update_option( 'woocommerce_enable_coupons', 'yes' );
update_option( 'woocommerce_calc_taxes', 'no' );
update_option( 'woocommerce_currency', 'USD' );
update_option( 'woocommerce_default_country', 'US:CA' );

$cod = get_option( 'woocommerce_cod_settings', array() );
update_option(
	'woocommerce_cod_settings',
	array_merge(
		is_array( $cod ) ? $cod : array(),
		array(
			'enabled'            => 'yes',
			'enable_for_virtual' => 'yes',
			'enable_for_methods' => array(),
		)
	)
);

// Virtual: no shipping address or shipping method needed at checkout.
$product = new WC_Product_Simple();
$product->set_name( 'GoPayLocal check product' );
$product->set_status( 'publish' );
$product->set_regular_price( '100.00' );
$product->set_virtual( true );
$product_id = $product->save();

// The same row WooCommerce > Settings > Advanced > REST API > Add key writes
// (WC_Auth::create_keys): the key is stored hashed, the secret as it is.
global $wpdb;
$consumer_key    = 'ck_' . wc_rand_hash();
$consumer_secret = 'cs_' . wc_rand_hash();
$inserted        = $wpdb->insert(
	$wpdb->prefix . 'woocommerce_api_keys',
	array(
		'user_id'         => 1,
		'description'     => 'GoPayLocal store check',
		'permissions'     => 'read_write',
		'consumer_key'    => wc_api_hash( $consumer_key ),
		'consumer_secret' => $consumer_secret,
		'truncated_key'   => substr( $consumer_key, -7 ),
	),
	array( '%d', '%s', '%s', '%s', '%s', '%s' )
);

if ( ! $product_id || ! $inserted ) {
	fwrite( STDERR, "Could not create the product or the API key\n" );
	exit( 1 );
}

echo wp_json_encode(
	array(
		'product_id'      => $product_id,
		'consumer_key'    => $consumer_key,
		'consumer_secret' => $consumer_secret,
		'wordpress'       => get_bloginfo( 'version' ),
		'woocommerce'     => WC()->version,
	)
), "\n";
