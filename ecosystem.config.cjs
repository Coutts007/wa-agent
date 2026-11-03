// pm2 process definition. Usage:
//   pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup     # survive reboots (run the command `pm2 startup` prints)
//   pm2 logs wa-agent           # follow logs
module.exports = {
  apps: [
    {
      name: 'wa-agent',
      script: 'src/index.js',
      node_args: '--disable-warning=ExperimentalWarning',
      cwd: __dirname,
      autorestart: true, // also what makes the /restart command work
      restart_delay: 3000,
      max_restarts: 50,
      max_memory_restart: '400M',
      time: true, // timestamps in pm2 logs
      env: { NODE_ENV: 'production' },
    },
  ],
}
