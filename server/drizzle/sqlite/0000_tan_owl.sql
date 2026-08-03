CREATE TABLE IF NOT EXISTS `companies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`gstin` text,
	`pan` text,
	`city` text,
	`plan` text DEFAULT 'standard',
	`trial_ends_at` text,
	`settings` text DEFAULT '{}',
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `users` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`password` text NOT NULL,
	`role` text NOT NULL,
	`department` text,
	`active` integer DEFAULT 1,
	`last_login_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "users_role_check" CHECK("users"."role" IN ('cfo','finance_manager','finance_executive'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sessions` (
	`token` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`user_id` text,
	`user_name` text,
	`action` text NOT NULL,
	`entity` text,
	`entity_id` text,
	`details` text,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_audit_company_at` ON `audit_logs` (`company_id`,`at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `banks` (
	`code` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'aa' NOT NULL,
	`aa_supported` integer DEFAULT 1
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `bank_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`bank_code` text NOT NULL,
	`account_name` text NOT NULL,
	`account_number` text NOT NULL,
	`type` text DEFAULT 'current' NOT NULL,
	`ifsc` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`source` text NOT NULL,
	`consent_id` text,
	`last_synced_at` text,
	`opened_at` text NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bank_code`) REFERENCES `banks`(`code`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `bank_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`account_id` text NOT NULL,
	`external_id` text,
	`txn_date` text NOT NULL,
	`value_date` text,
	`amount` real NOT NULL,
	`balance_after` real,
	`description` text,
	`mode` text,
	`ref_no` text,
	`status` text DEFAULT 'posted' NOT NULL,
	`matched` integer DEFAULT 0,
	`matched_id` text,
	`raw_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `bank_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_btx_company_matched` ON `bank_transactions` (`company_id`,`matched`,`status`,`txn_date`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_btx_company_txndate` ON `bank_transactions` (`company_id`,`txn_date`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `bank_transactions_account_external` ON `bank_transactions` (`account_id`,`external_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `cash_daily` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`account_id` text NOT NULL,
	`date` text NOT NULL,
	`closing_balance` real NOT NULL,
	`source` text DEFAULT 'aa'
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_cd_account_date` ON `cash_daily` (`account_id`,`date`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `cash_daily_account_date` ON `cash_daily` (`account_id`,`date`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `vendors` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`gstin` text,
	`pan` text,
	`bank_account` text,
	`ifsc` text,
	`upi_id` text,
	`email` text,
	`ledger_name` text NOT NULL,
	`tds_section` text,
	`tds_rate` real DEFAULT 0,
	`credit_days` integer DEFAULT 30,
	`category` text,
	`active` integer DEFAULT 1,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_vendors_company_active` ON `vendors` (`company_id`,`active`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`invoice_no` text NOT NULL,
	`vendor_id` text,
	`invoice_date` text NOT NULL,
	`due_date` text,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`gross_amount` real DEFAULT 0 NOT NULL,
	`taxable_amount` real DEFAULT 0 NOT NULL,
	`cgst` real DEFAULT 0,
	`sgst` real DEFAULT 0,
	`igst` real DEFAULT 0,
	`cess` real DEFAULT 0,
	`tds_amount` real DEFAULT 0,
	`net_payable` real DEFAULT 0,
	`gstin_vendor` text,
	`hsns` text DEFAULT '[]',
	`purchase_order_no` text,
	`receipt_note_no` text,
	`three_way_match` text,
	`ocr_json` text,
	`notes` text,
	`currency` text DEFAULT 'INR',
	`created_by` text,
	`approved_by` text,
	`approved_at` text,
	`paid_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_invoices_company_no` ON `invoices` (`company_id`,`invoice_no`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_invoices_company_status` ON `invoices` (`company_id`,`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_invoices_company_date` ON `invoices` (`company_id`,`invoice_date`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `invoice_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`hsn` text,
	`description` text,
	`qty` real DEFAULT 1,
	`rate` real DEFAULT 0,
	`taxable` real DEFAULT 0,
	`cgst` real DEFAULT 0,
	`sgst` real DEFAULT 0,
	`igst` real DEFAULT 0,
	`cess` real DEFAULT 0,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`level` integer DEFAULT 1 NOT NULL,
	`required_role` text,
	`threshold_note` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`approver_id` text,
	`approver_name` text,
	`comment` text,
	`decided_at` text,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`vendor_id` text,
	`invoice_ids` text DEFAULT '[]',
	`amount` real NOT NULL,
	`mode` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`scheduled_date` text,
	`bank_account_id` text,
	`reference` text,
	`gateway` text,
	`gateway_txn_id` text,
	`gst_ledger` text,
	`tds_section` text,
	`tds_amount` real DEFAULT 0,
	`net_amount` real NOT NULL,
	`initiated_by` text,
	`approved_by` text,
	`failure_reason` text,
	`initiated_at` text,
	`processed_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_payments_company_status` ON `payments` (`company_id`,`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `recon_matches` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`bank_txn_id` text NOT NULL,
	`payment_id` text,
	`tally_voucher_no` text,
	`match_type` text NOT NULL,
	`confidence` real,
	`status` text DEFAULT 'matched' NOT NULL,
	`matched_by` text,
	`matched_at` text,
	`notes` text,
	FOREIGN KEY (`bank_txn_id`) REFERENCES `bank_transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `gstr2b_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`period` text NOT NULL,
	`gstin` text,
	`total_itc` real DEFAULT 0,
	`itc_cgst` real DEFAULT 0,
	`itc_sgst` real DEFAULT 0,
	`itc_igst` real DEFAULT 0,
	`data_json` text DEFAULT '[]',
	`cdnr_json` text DEFAULT '[]',
	`source` text DEFAULT 'gstr2b',
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_g2b_company_period` ON `gstr2b_snapshots` (`company_id`,`period`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `gst_mismatches` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`period` text NOT NULL,
	`invoice_no` text,
	`vendor_gstin` text,
	`vendor_name` text,
	`platform_amount` real DEFAULT 0,
	`gstr2b_amount` real DEFAULT 0,
	`variance` real DEFAULT 0,
	`status` text DEFAULT 'open',
	`note` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_gst_mm_company_status` ON `gst_mismatches` (`company_id`,`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `tally_sync_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text,
	`action` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`queued_at` text,
	`synced_at` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `tally_health` (
	`company_id` text PRIMARY KEY NOT NULL,
	`last_sync_at` text,
	`last_success_at` text,
	`status` text DEFAULT 'connected' NOT NULL,
	`queue_depth` integer DEFAULT 0,
	`version` text DEFAULT 'TallyPrime 4.2',
	`mode` text DEFAULT 'single-user',
	`uptime_30d` real DEFAULT 99.6,
	`last_error` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `onboarding_steps` (
	`company_id` text NOT NULL,
	`step` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`detail` text,
	`at` text,
	PRIMARY KEY(`company_id`, `step`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `email_inbox` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`from_email` text,
	`subject` text,
	`body` text,
	`attachments` text DEFAULT '[]',
	`received_at` text NOT NULL,
	`processed` integer DEFAULT 0,
	`invoice_id` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`type` text NOT NULL,
	`payload` text DEFAULT '{}',
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0,
	`run_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `usage_daily` (
	`company_id` text NOT NULL,
	`date` text NOT NULL,
	`dau` integer DEFAULT 0,
	`mau` integer DEFAULT 0,
	PRIMARY KEY(`company_id`, `date`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `decentro_links` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`account_number` text NOT NULL,
	`mobile` text,
	`customer_id` text,
	`bank_code` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`decentro_txn_id` text,
	`redirect_url` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`linked_at` text,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `tally_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`parent` text,
	`tally_guid` text,
	`tally_alterid` integer DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_tally_groups_guid` ON `tally_groups` (`company_id`,`tally_guid`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `tally_groups_company_name` ON `tally_groups` (`company_id`,`name`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `tally_ledgers` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`group_name` text,
	`opening_balance` real DEFAULT 0,
	`gstin` text,
	`tally_guid` text,
	`tally_alterid` integer DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_tally_ledgers_guid` ON `tally_ledgers` (`company_id`,`tally_guid`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `tally_ledgers_company_name` ON `tally_ledgers` (`company_id`,`name`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `tally_vouchers` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`voucher_number` text,
	`voucher_type` text,
	`date` text,
	`amount` real DEFAULT 0,
	`party_name` text,
	`entry_json` text DEFAULT '[]',
	`tally_guid` text,
	`tally_alterid` integer DEFAULT 0,
	`cancelled` integer DEFAULT 0 NOT NULL,
	`imported_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_tally_vouchers_guid` ON `tally_vouchers` (`company_id`,`tally_guid`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tv_company_type` ON `tally_vouchers` (`company_id`,`voucher_type`,`cancelled`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tv_company_date` ON `tally_vouchers` (`company_id`,`date`);