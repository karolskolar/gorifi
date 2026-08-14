// ⚠ SECRETS COME FROM AN .env FILE OUTSIDE THE DEPLOYED TREE (07 §UC-IA-009).
// `/var/www/gorifi/.env` and `/var/www/gorifi-staging/.env` (mode 600, owner `gorifi`).
// They sit one level ABOVE `backend/` on purpose: `deploy.sh` rsyncs the app directory
// with `--delete`, so a `backend/.env` would be wiped on every deploy.
//
// What those files may contain — the mailer is OFF unless the first three are all set
// (`backend/src/helpers/mailer.js`), and one boot line in `out.log` says which way it
// resolved:
//   MAILGUN_API_KEY    required to send. Never logged, never in an API response.
//   MAILGUN_DOMAIN     the verified sending domain, e.g. mg.podpultovka.biz
//   MAILGUN_BASE_URL   region endpoint, e.g. https://api.eu.mailgun.net (EU account)
//   PUBLIC_BASE_URL    optional. The login URL printed in the credentials e-mail and in
//                      the admin's copy-paste message. Unset ⇒ the admin browser's
//                      `Origin` (allowlist-checked) ⇒ https://podpultovka.biz. Set it if
//                      a non-browser caller must produce the canonical domain.
//   MAILGUN_FROM       optional. Overrides the default `Podpultovka <no-reply@DOMAIN>`;
//                      only worth setting once a real reply-to mailbox exists.
// (`DB_PATH`, `CORS_ORIGIN` and the four `RATE_LIMIT_*` vars also work here.)
//
// ⚠ `--env-file-if-exists`, NEVER `--env-file` (needs Node ≥ 20.12; the servers run
// 20.20.2). `--env-file` treats a missing file as fatal — `node: /path/.env: not found`
// and the process never starts — which would make the app UNSTARTABLE on any host
// without the secrets (a fresh container, a clone, a developer's machine). With
// `-if-exists` node logs one line to stderr and continues, and `helpers/mailer.js` is a
// documented no-op when the vars are absent.
//
// `node_args` is the field that carries these to the interpreter for a `script:` entry
// (`interpreter_args` is only an alias of it in PM2's schema). Verified empirically on
// PM2 7.0.3: the flag shows up in the child's `process.execArgv`, a present file's vars
// reach `process.env`, and a missing one starts anyway.
module.exports = {
  apps: [
    {
      name: 'gorifi-backend',
      script: 'src/index.js',
      cwd: '/var/www/gorifi/backend',
      node_args: '--env-file-if-exists=/var/www/gorifi/.env',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      error_file: '/var/log/gorifi/error.log',
      out_file: '/var/log/gorifi/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    },
    {
      name: 'gorifi-staging',
      script: 'src/index.js',
      cwd: '/var/www/gorifi-staging/backend',
      node_args: '--env-file-if-exists=/var/www/gorifi-staging/.env',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3001
      },
      error_file: '/var/log/gorifi-staging/error.log',
      out_file: '/var/log/gorifi-staging/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    }
  ]
};
