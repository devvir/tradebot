# MongoDB Collections Summary

## Baseline (raw, full messages)

| Collection name | Properties | Storage size | Documents | Avg. document size | Indexes | Total index size |
|---|---|---|---|---|---|---|
| orderBookL2 | - | 853.67 MB | 11M | 365.00 B | 1 | 170.77 MB |
| quote | - | 145.40 MB | 4.2M | 199.00 B | 1 | 72.30 MB |
| instrument | - | 66.33 MB | 1.4M | 198.00 B | 1 | 23.50 MB |
| trade | - | 13.60 MB | 298K | 248.00 B | 1 | 3.84 MB |
| settlement | - | 151.55 kB | 5 | 85.16 kB | 1 | 36.86 kB |
| connected | - | 77.82 kB | 888 | 110.00 B | 1 | 61.44 kB |
| funding | - | 73.73 kB | 80 | 3.29 kB | 1 | 36.86 kB |
| chat | - | 61.44 kB | 132 | 372.00 B | 1 | 36.86 kB |
| announcement | - | 36.86 kB | 4 | 214.00 B | 1 | 36.86 kB |
| insurance | - | 36.86 kB | 5 | 735.00 B | 1 | 36.86 kB |
| liquidation | - | 36.86 kB | 25 | 202.00 B | 1 | 36.86 kB |
| publicNotifications | - | 36.86 kB | 4 | 242.00 B | 1 | 36.86 kB |

**Collected over ~6.7 hours: ~1.08 GB | Week: ~27.0 GB | Month: ~115.6 GB | Year: ~1.37 TB**

**Data only (no indexes): ~0.81 GB | Week: ~20.2 GB | Month: ~86.6 GB | Year: ~1.05 TB**

## Encoded Database

| Collection name | Properties | Storage size | Documents | Avg. document size | Indexes | Total index size |
|---|---|---|---|---|---|---|
| orderBookL2 | - | 1.25 GB | 21M | 122.00 B | 1 | 319.30 MB |
| quote | - | 200.40 MB | 8.9M | 65.00 B | 1 | 134.84 MB |
| instrument | - | 8.50 MB | 116K | 181.00 B | 1 | 1.84 MB |
| trade | - | 4.95 MB | 67K | 184.00 B | 1 | 1.00 MB |
| chat | - | 172.03 kB | 1K | 258.00 B | 1 | 73.73 kB |
| connected | - | 86.02 kB | 1.5K | 63.00 B | 1 | 61.44 kB |
| settlement | - | 69.63 kB | 1 | 93.44 kB | 1 | 20.48 kB |
| funding | - | 53.25 kB | 3 | 35.28 kB | 1 | 36.86 kB |
| announcement | - | 36.86 kB | 10 | 26.00 B | 1 | 36.86 kB |
| insurance | - | 36.86 kB | 1 | 548.00 B | 1 | 20.48 kB |
| liquidation | - | 36.86 kB | 123 | 137.00 B | 1 | 36.86 kB |
| publicNotifications | - | 36.86 kB | 10 | 26.00 B | 1 | 36.86 kB |

**Collected over 12 hours: ~1.46 GB | Week: ~20.4 GB | Month: ~87.6 GB | Year: ~1.07 TB**

**Data only (no indexes): ~1.00 GB | Week: ~14.0 GB | Month: ~60.0 GB | Year: ~0.73 TB**
