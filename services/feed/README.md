# Feed Service

BitMEX WebSocket reader service that connects to BitMEX's real-time data feed, subscribes to specified channels and symbols, and publishes market data to RabbitMQ for downstream processing.

## Features

- Real-time WebSocket connection to BitMEX
- Configurable channel and symbol subscriptions
- Pub/Sub integration with RabbitMQ
- Automatic reconnection with exponential backoff
- Health check endpoint for monitoring
- Multi-instance support with replica coordination
