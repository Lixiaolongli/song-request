// pm2 进程配置。deploy.sh 会自动使用它，也可以手动：
//   PORT=80 PUBLIC_URL=http://你的IP pm2 startOrReload ecosystem.config.cjs --update-env

module.exports = {
  apps: [
    {
      name: 'song-request',
      script: 'server.js',
      cwd: __dirname,
      // 必须是单实例：队列和在线观众列表都存在进程内存里，
      // 多实例会导致不同观众连到不同进程、看到的队列互不相通。
      // 要扩容得先把状态挪到 Redis 之类的共享存储。
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || '80',
        PUBLIC_URL: process.env.PUBLIC_URL || '',
        BIND: '0.0.0.0',
      },
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
