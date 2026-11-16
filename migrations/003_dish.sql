CREATE TABLE dish (
  dish_id                VARCHAR(64) PRIMARY KEY,
  name                   VARCHAR(60) NOT NULL,
  category               VARCHAR(30) NOT NULL,
  description            VARCHAR(300),
  reference_price_cents  BIGINT NOT NULL,
  image_url              VARCHAR(2048),
  image_object_key       VARCHAR(512),
  image_mime_type        VARCHAR(32),
  image_size_bytes       INTEGER,
  image_updated_at       TIMESTAMPTZ,
  image_updated_by       VARCHAR(128) REFERENCES app_user (user_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  sale_status            VARCHAR(16) NOT NULL DEFAULT 'OFF_SHELF',
  created_at             TIMESTAMPTZ NOT NULL,
  created_by             VARCHAR(128) NOT NULL REFERENCES app_user (user_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  updated_at             TIMESTAMPTZ NOT NULL,
  updated_by             VARCHAR(128) NOT NULL REFERENCES app_user (user_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_dish_dish_id_uuid CHECK (
    dish_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT ck_dish_name CHECK (char_length(name) BETWEEN 1 AND 60),
  CONSTRAINT ck_dish_category CHECK (char_length(category) BETWEEN 1 AND 30),
  CONSTRAINT ck_dish_description CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 300),
  CONSTRAINT ck_dish_price_positive CHECK (reference_price_cents > 0),
  CONSTRAINT ck_dish_sale_status CHECK (sale_status IN ('ON_SALE', 'OFF_SHELF')),
  CONSTRAINT ck_dish_image_complete CHECK (
    (image_url IS NULL AND image_object_key IS NULL AND image_mime_type IS NULL AND image_size_bytes IS NULL)
    OR
    (image_url IS NOT NULL AND image_object_key IS NOT NULL AND image_mime_type IS NOT NULL AND image_size_bytes IS NOT NULL)
  ),
  CONSTRAINT ck_dish_image_url CHECK (
    image_url IS NULL OR image_url ~ '^/api/v1/dish-images/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT ck_dish_image_mime CHECK (
    image_mime_type IS NULL OR image_mime_type IN ('image/jpeg', 'image/png', 'image/webp')
  ),
  CONSTRAINT ck_dish_image_size CHECK (
    image_size_bytes IS NULL OR image_size_bytes BETWEEN 1 AND 5242880
  ),
  CONSTRAINT ck_dish_image_object_key CHECK (
    image_object_key IS NULL OR image_object_key ~
      '^dish-images/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$'
  ),
  CONSTRAINT ck_dish_image_audit_pair CHECK (
    (image_updated_at IS NULL) = (image_updated_by IS NULL)
  ),
  CONSTRAINT ck_dish_image_audit_present CHECK (
    image_url IS NULL OR (image_updated_at IS NOT NULL AND image_updated_by IS NOT NULL)
  ),
  CONSTRAINT ck_dish_image_audit_time CHECK (
    image_updated_at IS NULL OR image_updated_at >= created_at
  ),
  CONSTRAINT ck_dish_audit_time CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX uq_dish_image_url
  ON dish (image_url)
  WHERE image_url IS NOT NULL;

CREATE UNIQUE INDEX uq_dish_image_object_key
  ON dish (image_object_key)
  WHERE image_object_key IS NOT NULL;

CREATE INDEX idx_dish_admin_list
  ON dish (created_at DESC, dish_id DESC);
