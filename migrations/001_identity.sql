CREATE TABLE app_user (
  user_id VARCHAR(128) PRIMARY KEY,
  employee_no VARCHAR(64),
  name VARCHAR(200) NOT NULL,
  department VARCHAR(200),
  account_status VARCHAR(16) NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT ck_app_user_user_id CHECK (char_length(btrim(user_id)) BETWEEN 1 AND 128),
  CONSTRAINT ck_app_user_name CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT ck_app_user_employee_no CHECK (employee_no IS NULL OR char_length(btrim(employee_no)) BETWEEN 1 AND 64),
  CONSTRAINT ck_app_user_department CHECK (department IS NULL OR char_length(btrim(department)) BETWEEN 1 AND 200),
  CONSTRAINT ck_app_user_account_status CHECK (account_status IN ('ACTIVE', 'DISABLED'))
);

CREATE UNIQUE INDEX uq_app_user_employee_no
  ON app_user (employee_no)
  WHERE employee_no IS NOT NULL;

CREATE TABLE user_role (
  user_id VARCHAR(128) NOT NULL REFERENCES app_user (user_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  role VARCHAR(32) NOT NULL,
  PRIMARY KEY (user_id, role),
  CONSTRAINT ck_user_role_role CHECK (role IN ('EMPLOYEE', 'MENU_ADMIN'))
);
