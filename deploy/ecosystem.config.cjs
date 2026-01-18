module.exports = {
  apps: [
    {
      name: 'gorifi-backend',
      script: 'src/index.js',
      cwd: '/var/www/gorifi/backend',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
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
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
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
