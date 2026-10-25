-- A QR session being scanned for a store; the store switches to it only once the phone is connected.
ALTER TABLE whatsapp_numbers ADD COLUMN IF NOT EXISTS pending_store_id bigint REFERENCES stores(id) ON DELETE SET NULL;
