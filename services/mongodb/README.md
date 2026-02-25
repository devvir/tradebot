# MongoDB Service

Document database (MongoDB 7). Provides persistent storage for application data.

## Docker Commands

Build the image:
```bash
docker compose -f services/mongodb/docker/compose.yml build
```

Start the container:
```bash
docker compose -f services/mongodb/docker/compose.yml up -d
```

Stop the container:
```bash
docker compose -f services/mongodb/docker/compose.yml down
```

View logs:
```bash
docker compose -f services/mongodb/docker/compose.yml logs -f
```

## Official Documentation

- [MongoDB Documentation](https://docs.mongodb.com/)
- [MongoDB Server Manual](https://docs.mongodb.com/manual/)
- [MongoDB Docker Hub](https://hub.docker.com/_/mongo)
