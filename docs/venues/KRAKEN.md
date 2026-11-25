# Kraken

Kraken as a source of market data. Only its public WebSocket API has been examined; nothing here
says anything about its archives or its REST API.

## WebSocket

Frames captured from the live endpoint on 2026-07-26, trimmed; `…` marks what was cut.

**One public endpoint, `wss://ws.kraken.com/v2`.** A symbol is the pair with a slash: `BTC/USD`,
`ETH/USD`.

**On connect, before anything is asked**, a status frame:

```
← {"channel":"status","type":"update","data":[{"version":"2.0.10","system":"online",…}]}
```

**A subscription is a channel and a list of symbols**, and the ack echoes both:

```
→ {"method":"subscribe","params":{"channel":"trade","symbol":["BTC/USD"]}}
← {"method":"subscribe","result":{"channel":"trade","snapshot":false,"symbol":"BTC/USD"},"success":true,…}
← {"channel":"trade","type":"update","data":[{"price":64304.9,…}]}
```

- **The ack's `result.symbol` is a string**, where the request sent a list.
- **Data frames carry `channel`, `type` and `data`**, and `data` is a list. `type` was `update` on
  trades and `snapshot` on a book:
  `{"channel":"book","type":"snapshot","data":[{"symbol":"BTC/USD",…}]}`.
- **Acks carry `method` and no `type`.**
- **A heartbeat arrives periodically**: `{"channel":"heartbeat"}`, with no `type` and no `data`.
- **`status` and `heartbeat` are channels too**, so a frame's `channel` alone does not tell data
  from connection chatter.

**An unknown channel is refused**, and the refusal names neither the channel nor the symbol:

```
→ {"method":"subscribe","params":{"channel":"nonsense","symbol":["BTC/USD"]}}
← {"error":"Subscription name invalid","method":"subscribe","success":false}
```
