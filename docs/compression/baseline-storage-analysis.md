# MongoDB Baseline Storage Analysis

**Generated:** 2026-02-18T20:58:03.641Z

**Database:** `tradebot`

## Summary by Collection

| Collection | Partial Docs | Partial Avg | Non-Partial Docs | Non-Partial Avg | Index Size |
|---|---|---|---|---|---|
| `funding` | 2 | 443.00 B | 1 | 231.00 B | 36.00 KB |
| `instrument` | 1 | 1.14 MB | 325,056 | 199.04 B | 5.36 MB |
| `insurance` | 1 | 735.00 B | 0 | 0 B | 20.00 KB |
| `liquidation` | 2 | 218.00 B | 0 | 0 B | 36.00 KB |
| `orderBookL2` | 3 | 675.63 KB | 215,570 | 1.39 KB | 3.97 MB |
| `quote` | 3 | 385.67 B | 181,019 | 196.06 B | 3.38 MB |
| `quoteBin1d` | 1 | 267.00 B | 0 | 0 B | 20.00 KB |
| `quoteBin1h` | 1 | 392.00 B | 1 | 203.00 B | 36.00 KB |
| `quoteBin1m` | 1 | 388.00 B | 69 | 201.09 B | 36.00 KB |
| `quoteBin5m` | 1 | 392.00 B | 14 | 201.29 B | 36.00 KB |
| `settlement` | 2 | 493.00 B | 0 | 0 B | 36.00 KB |
| `trade` | 3 | 642.00 B | 1,354 | 481.40 B | 72.00 KB |
| `tradeBin1d` | 1 | 394.00 B | 0 | 0 B | 20.00 KB |
| `tradeBin1h` | 1 | 622.00 B | 1 | 298.00 B | 36.00 KB |
| `tradeBin1m` | 1 | 622.00 B | 69 | 299.51 B | 36.00 KB |
| `tradeBin5m` | 1 | 626.00 B | 14 | 301.43 B | 36.00 KB |

## Totals

| Metric | Value |
|---|---|
| Total Partial Docs | 25 |
| Total Non-Partial Docs | 723,168 |
| Partials Storage | 3.12 MB |
| Non-Partials Storage | 387.94 MB |
| All Indexes | 13.16 MB |
| **Total** | **404.22 MB** |

## Per-Collection Detail

### `funding`
| Type | Count | Avg Size | Total |
|---|---|---|---|
| Partial | 2 | 443.00 B | 886.00 B |
| Non-Partial | 1 | 231.00 B | 231.00 B |
| Indexes | - | - | 36.00 KB |
| **Total** | **3** | - | **37.09 KB** |

### `instrument`
| Type | Count | Avg Size | Total |
|---|---|---|---|
| Partial | 1 | 1.14 MB | 1.14 MB |
| Non-Partial | 325,056 | 199.04 B | 61.70 MB |
| Indexes | - | - | 5.36 MB |
| **Total** | **325,057** | - | **68.20 MB** |

### `insurance`
| Type | Count | Avg Size | Total |
|---|---|---|---|
| Partial | 1 | 735.00 B | 735.00 B |
| Non-Partial | 0 | 0 B | 0 B |
| Indexes | - | - | 20.00 KB |
| **Total** | **1** | - | **20.72 KB** |

### `liquidation`
| Type | Count | Avg Size | Total |
|---|---|---|---|
| Partial | 2 | 218.00 B | 436.00 B |
| Non-Partial | 0 | 0 B | 0 B |
| Indexes | - | - | 36.00 KB |
| **Total** | **2** | - | **36.43 KB** |

### `orderBookL2`
| Type | Count | Avg Size | Total |
|---|---|---|---|
| Partial | 3 | 675.63 KB | 1.98 MB |
| Non-Partial | 215,570 | 1.39 KB | 291.73 MB |
| Indexes | - | - | 3.97 MB |
| **Total** | **215,573** | - | **297.68 MB** |

### `quote`
| Type | Count | Avg Size | Total |
|---|---|---|---|
| Partial | 3 | 385.67 B | 1.13 KB |
| Non-Partial | 181,019 | 196.06 B | 33.85 MB |
| Indexes | - | - | 3.38 MB |
| **Total** | **181,022** | - | **37.23 MB** |

### `quoteBin1d`
| Type | Count | Avg Size | Total |
|---|---|---|---|
| Partial | 1 | 267.00 B | 267.00 B |
| Non-Partial | 0 | 0 B | 0 B |
| Indexes | - | - | 20.00 KB |
| **Total** | **1** | - | **20.26 KB** |

### `quoteBin1h`
| Type | Count | Avg Size | Total |
|---|---|---|---|
| Partial | 1 | 392.00 B | 392.00 B |
| Non-Partial | 1 | 203.00 B | 203.00 B |
| Indexes | - | - | 36.00 KB |
| **Total** | **2** | - | **36.58 KB** |

### `quoteBin1m`
| Type | Count | Avg Size | Total |
|---|---|---|---|
| Partial | 1 | 388.00 B | 388.00 B |
| Non-Partial | 69 | 201.09 B | 13.55 KB |
| Indexes | - | - | 36.00 KB |
| **Total** | **70** | - | **49.93 KB** |

### `quoteBin5m`
| Type | Count | Avg Size | Total |
|---|---|---|---|
| Partial | 1 | 392.00 B | 392.00 B |
| Non-Partial | 14 | 201.29 B | 2.75 KB |
| Indexes | - | - | 36.00 KB |
| **Total** | **15** | - | **39.13 KB** |

### `settlement`
| Type | Count | Avg Size | Total |
|---|---|---|---|
| Partial | 2 | 493.00 B | 986.00 B |
| Non-Partial | 0 | 0 B | 0 B |
| Indexes | - | - | 36.00 KB |
| **Total** | **2** | - | **36.96 KB** |

### `trade`
| Type | Count | Avg Size | Total |
|---|---|---|---|
| Partial | 3 | 642.00 B | 1.88 KB |
| Non-Partial | 1,354 | 481.40 B | 636.54 KB |
| Indexes | - | - | 72.00 KB |
| **Total** | **1,357** | - | **710.42 KB** |

### `tradeBin1d`
| Type | Count | Avg Size | Total |
|---|---|---|---|
| Partial | 1 | 394.00 B | 394.00 B |
| Non-Partial | 0 | 0 B | 0 B |
| Indexes | - | - | 20.00 KB |
| **Total** | **1** | - | **20.38 KB** |

### `tradeBin1h`
| Type | Count | Avg Size | Total |
|---|---|---|---|
| Partial | 1 | 622.00 B | 622.00 B |
| Non-Partial | 1 | 298.00 B | 298.00 B |
| Indexes | - | - | 36.00 KB |
| **Total** | **2** | - | **36.90 KB** |

### `tradeBin1m`
| Type | Count | Avg Size | Total |
|---|---|---|---|
| Partial | 1 | 622.00 B | 622.00 B |
| Non-Partial | 69 | 299.51 B | 20.18 KB |
| Indexes | - | - | 36.00 KB |
| **Total** | **70** | - | **56.79 KB** |

### `tradeBin5m`
| Type | Count | Avg Size | Total |
|---|---|---|---|
| Partial | 1 | 626.00 B | 626.00 B |
| Non-Partial | 14 | 301.43 B | 4.12 KB |
| Indexes | - | - | 36.00 KB |
| **Total** | **15** | - | **40.73 KB** |

