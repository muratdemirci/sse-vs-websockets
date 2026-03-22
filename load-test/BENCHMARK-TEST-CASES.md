# SSE vs WebSocket: Benchmark Test Cases

> Bu dosya, makale icin adil ve kapsamli benchmark testleri tasarlamak amaciyla
> Staff Engineer, Backend Engineer, QA Engineer ve DevOps Engineer perspektiflerinden
> birlestirilerek olusturulmustur.

---

## Temel Ilkeler

1. **SSE ve WebSocket farkli problemleri cozer.** SSE tek yonlu (server→client) HTTP uzerinden push; WebSocket cift yonlu full-duplex TCP.
2. **Transport nadiren darbogazdir.** Serialization, GC, kernel buffer yonetimi genelde daha baskindir. Protokol framing overhead'i (WS: 2-14 byte, SSE: ~8 byte) uygulama boyutlarinda ihmal edilebilir.
3. **HTTP/2, SSE denklemini tamamen degistirir.** 6 baglanti limiti HTTP/1.1 artefaktidir. HTTP/2'de SSE baglantilar tek TCP uzerinde multiplexlenir.
4. **Adil karsilastirma icin:** Ayni payload, ayni rate, ayni broadcast dongusu, ayni Node.js surumu.

---

## Karsilastirma Boyutlari

| Boyut | Ne Olcer | Neden Onemli |
|-------|----------|--------------|
| Baglanti kurulum suresi | `new WebSocket()` / `new EventSource()` → ilk mesaj | Startup ve reconnect maliyeti |
| Server→Client latency | `Date.now() - serverTimestamp` | Temel gercek zamanlilik metrigi |
| Round-trip latency | Client gonder → server echo → client al | Interaktif uygulamalar icin kritik |
| Throughput (msg/sec) | Tum client'lara saniyede teslim edilen mesaj | Sunucu kapasitesi |
| Baglanti basina bellek | RSS delta / baglanti sayisi delta | Maks baglanti sinirina etkisi |
| Mesaj basina CPU | CPU% / msg/sec | Broadcast verimlilige |
| Event loop lag | `setInterval` gecikme farki | I/O aclik gostergesi |
| Baglanti dayanakliligi | Zaman icinde dusen baglanti sayisi | Uzun omurlu stream guvenilirligi |
| Reconnection | Kopma sonrasi yeniden baglanti suresi ve mesaj kaybi | SSE'nin Last-Event-ID avantaji |
| Fan-out maliyeti | N arttikca teslimat suresi bozulmasi | Olceklenebilirlik tavani |
| Payload boyutu hassasiyeti | Boyut arttikca latency/throughput degisimi | Framing overhead'in onemi |

---

## KATEGORI 1: LATENCY TESTLERI

### TC-01: Baseline Latency (Dusuk Yuk)

| Alan | Detay |
|------|-------|
| **Kategori** | Latency |
| **Aciklama** | Dusuk yuk altinda temel server→client mesaj teslim gecikmesi |
| **Setup** | 100 client, 1 msg/sec, 64B payload, 30 saniye |
| **Adimlar** | 1) Sunuculari baslat 2) 100 client bagla 3) 30s boyunca latency olc 4) p50/p95/p99 hesapla |
| **Metrikler** | p50, p95, p99, max latency, stddev, event loop lag |
| **Beklenen sonuc** | Yaklasik esit. Her iki protokol de dusuk yukte benzer performans gosterir |
| **CLI** | `node client-simulator.js websocket 100 --mode=latency --duration=30` |
| | `node client-simulator.js sse 100 --mode=latency --duration=30` |

### TC-02: Yuk Altinda Latency

| Alan | Detay |
|------|-------|
| **Kategori** | Latency |
| **Aciklama** | Yuksek mesaj frekansi ve cok sayida client ile latency |
| **Setup** | 1000 client, 50 msg/sec, 64B payload, 30 saniye |
| **Adimlar** | 1) Sunuculari `--rate=50` ile baslat 2) 1000 client bagla 3) Latency olc |
| **Metrikler** | p50, p95, p99, max latency, CPU%, event loop lag, dropped connections |
| **Beklenen sonuc** | WebSocket hafif avantajli (daha az framing overhead, masking yok broadcast'te) |
| **CLI** | `node client-simulator.js websocket 1000 --mode=latency --rate=50 --duration=30` |

### TC-03: Echo Round-Trip Latency (WEBSOCKET AVANTAJI)

| Alan | Detay |
|------|-------|
| **Kategori** | Latency - Bidirectional |
| **Aciklama** | Client mesaj gonderir, server echo yapar, client round-trip olcer |
| **Setup** | 100 client, her biri 10 echo/sec, 64B, 30 saniye |
| **Adimlar** | 1) WS: Client ws.send() → server echo → client olc 2) SSE: Client POST → server SSE push → client olc |
| **Metrikler** | Round-trip p50/p95/p99, upstream bandwidth |
| **Beklenen sonuc** | **WebSocket kesin kazanir** (2-5x). SSE her upstream mesaj icin yeni HTTP request acmak zorunda |
| **Gerekli degisiklik** | Server'a `--mode=echo` ekle, client-simulator'a echo modu ekle |
| **CLI** | `node client-simulator.js websocket 100 --mode=echo --echo-rate=10` |

### TC-04: Yuksek Frekanslı Chat Simulasyonu (WEBSOCKET AVANTAJI)

| Alan | Detay |
|------|-------|
| **Kategori** | Latency - Bidirectional |
| **Aciklama** | N client, her biri 1 msg/sec yukari gonderir, server herkese broadcast yapar |
| **Setup** | 200 client, her biri 1 msg/sec upstream, server broadcast, 30 saniye |
| **Adimlar** | 1) Her client periyodik mesaj gonderir 2) Server aldigini herkese yayar 3) Delivery latency olc |
| **Metrikler** | Mesaj teslim latency, server CPU, SSE tarafinda HTTP POST overhead |
| **Beklenen sonuc** | **WebSocket kazanir**. SSE sunucusu N POST/sec ile bombalanir |
| **Gerekli degisiklik** | Server'a chat-relay modu, client-simulator'a chat modu ekle |

---

## KATEGORI 2: THROUGHPUT TESTLERI

### TC-05: Maksimum Throughput Testi

| Alan | Detay |
|------|-------|
| **Kategori** | Throughput |
| **Aciklama** | Her protokolun client'lara mesaj dusurmeden verebilecegi maks msg/sec |
| **Setup** | 100 client, rate kademeli artirilir: 10→50→100→200→500→1000 msg/sec, 64B |
| **Adimlar** | 1) Her rate seviyesinde 10s calistir 2) Teslim orani olc (alınan/beklenen) 3) Latency bozulmasini izle |
| **Metrikler** | Delivery ratio, avg latency, p99 latency, CPU%, dropped connections |
| **Beklenen sonuc** | WebSocket hafif avantajli (daha hafif framing: 2B vs 8B overhead) |
| **CLI** | `node client-simulator.js websocket 100 --mode=throughput --duration=60` |

### TC-06: Buyuk Payload Throughput

| Alan | Detay |
|------|-------|
| **Kategori** | Throughput |
| **Aciklama** | Payload boyutu arttikca throughput nasil etkilenir |
| **Setup** | 100 client, 1 msg/sec, boyutlar: 64B→256B→1KB→4KB→16KB→64KB, her boyutta 10s |
| **Adimlar** | 1) Her boyut icin server'i yeniden konfigure et 2) Throughput ve latency olc |
| **Metrikler** | MB/sec, avg/p99 latency, CPU%, bandwidth utilization |
| **Beklenen sonuc** | Kucuk boyutlarda esit. 4KB+ da WebSocket hafif avantajli (SSE text framing overhead) |
| **CLI** | `node client-simulator.js websocket 100 --mode=payload-sweep --duration=60` |

### TC-07: Binary Data Transfer (WEBSOCKET AVANTAJI)

| Alan | Detay |
|------|-------|
| **Kategori** | Throughput - Binary |
| **Aciklama** | Binary veri transferi: WS native binary frame vs SSE base64 encoding |
| **Setup** | 100 client, 10 msg/sec, 4KB binary payload, 30 saniye |
| **Adimlar** | 1) WS: Buffer.alloc(4096) binary frame olarak gonder 2) SSE: Ayni buffer'i base64 encode edip gonder |
| **Metrikler** | Wire'daki byte, efektif throughput, encoding/decoding CPU maliyeti |
| **Beklenen sonuc** | **WebSocket kesin kazanir**. SSE %33 boyut artisi (base64) + encoding CPU maliyeti |
| **Gerekli degisiklik** | Server'lara `--binary` flag ekle |

---

## KATEGORI 3: OLCEKLENEBILIRLIK TESTLERI

### TC-08: Baglanti Olceklendirme (Fan-Out)

| Alan | Detay |
|------|-------|
| **Kategori** | Scalability |
| **Aciklama** | Artan sayida pasif client ile kaynak tuketimi |
| **Setup** | Kademeli: 100→500→1000→2000→5000→10000 client, 1 msg/sec, 64B |
| **Adimlar** | 1) Her tier'de 15s calistir 2) Memory, CPU, latency olc 3) Baglanti basina bellek hesapla |
| **Metrikler** | Baglanti basina RSS delta, CPU%, p99 latency, event loop lag, dosya descriptor sayisi |
| **Beklenen sonuc** | **SSE hafif avantajli**. SSE baglanti basina daha az durum tutar (WS state machine yok, frame parser yok) |
| **CLI** | `node client-simulator.js sse 10000 --mode=scalability` |

### TC-09: Baglanti Kurulum Maliyeti

| Alan | Detay |
|------|-------|
| **Kategori** | Scalability - Handshake |
| **Aciklama** | Tek tek baglanti kurup kopararak handshake overhead'i olcme |
| **Setup** | 1000 iterasyon, her birinde: baglan → ilk mesaji al → kopar |
| **Adimlar** | 1) Dongu: connect, firstMessage, disconnect 2) Her birinin suresini olc |
| **Metrikler** | Baglanti kurulum suresi p50/p95/p99 |
| **Beklenen sonuc** | **SSE avantajli** (standart HTTP GET, upgrade negotiation yok) |
| **Gerekli degisiklik** | client-simulator'a `--mode=connection-cost --iterations=N` ekle |

### TC-10: Maksimum Baglanti Tavani

| Alan | Detay |
|------|-------|
| **Kategori** | Scalability - Ceiling |
| **Aciklama** | Server'in yeni baglanti kabul edemeyecegi veya latency >1s olacagi noktayi bulma |
| **Setup** | Kademeli artis: 100→500→1K→5K→10K, latency esik 1000ms |
| **Adimlar** | 1) Her tier'de bagla 2) Basarili baglanti sayisi, latency, bellek kaydet 3) Durana kadar artir |
| **Metrikler** | Max basarili baglanti, tier basina latency, tier basina bellek, FD sayisi |
| **Beklenen sonuc** | Benzer sinirlar (her ikisi de FD limiti ile sinirli) |

---

## KATEGORI 4: GUVVENILIRLIK TESTLERI

### TC-11: Otomatik Reconnection (SSE AVANTAJI)

| Alan | Detay |
|------|-------|
| **Kategori** | Reliability - Reconnection |
| **Aciklama** | Baglanti kopusu sonrasi otomatik yeniden baglanti ve mesaj kurtarma |
| **Setup** | 100 client, 1 msg/sec, 60 saniye (20s normal → kopma → recovery) |
| **Adimlar** | 1) 100 client bagla 2) 20s normal calis 3) `/disconnect-all` endpoint'i ile tum baglantiları kop 4) Recovery suresini ve kaybolan mesajlari olc |
| **Metrikler** | Reconnection suresi (tum client'lar), kaybolan mesaj sayisi, mesaj kurtarma orani |
| **Beklenen sonuc** | **SSE kesin kazanir**. EventSource otomatik reconnect + Last-Event-ID ile mesaj replay yapar. WebSocket'te uygulama kodu gerekir |
| **Gerekli degisiklik** | SSE server'a `id:` field ve `Last-Event-ID` desteigi, `/disconnect-all` endpoint, mesaj ring buffer |

### TC-12: Connection Churn (Surekli Baglan/Kopar)

| Alan | Detay |
|------|-------|
| **Kategori** | Reliability - Churn |
| **Aciklama** | Surekli baglanti acma/kapama altinda bellek sizintisi ve kararlilik |
| **Setup** | 100 connect/sec + 100 disconnect/sec, ~500 sabit aktif baglanti, 60 saniye |
| **Adimlar** | 1) Surekli baglanti ac/kapat 2) Bellek buyumesini izle 3) Basarili baglanti oranini olc |
| **Metrikler** | Bellek buyume trendi (leak detection), event loop lag, GC sikligi, baglanti basari orani |
| **Beklenen sonuc** | SSE hafif avantajli (daha az per-connection state temizligi) |
| **Gerekli degisiklik** | client-simulator'a `--mode=churn` ekle |

### TC-13: Uzun Omurlu Baglanti Kararliligi (Soak Test)

| Alan | Detay |
|------|-------|
| **Kategori** | Reliability - Soak |
| **Aciklama** | 30 dakika boyunca kararlilık ve bellek sizintisi testi |
| **Setup** | 200 client, 1 msg/sec, 30 dakika |
| **Adimlar** | 1) Bagla 2) 30dk boyunca 1dk arayla bellek ve baglanti sayisi kaydet 3) Trend analizi yap |
| **Metrikler** | RSS bellek (1dk aralikla), aktif baglanti sayisi drifi, GC pause frekansi |
| **Beklenen sonuc** | Her ikisi de kararli olmali. Fark varsa implementasyon kalitesini gosterir |

### TC-14: Yavas Client (Backpressure)

| Alan | Detay |
|------|-------|
| **Kategori** | Reliability - Backpressure |
| **Aciklama** | Yavas client'larin hizli client'lari etkileyip etkilemedigini test etme |
| **Setup** | 100 client: 95 normal + 5 yavas (okuma 500ms geciktirilmis), 10 msg/sec, 30 saniye |
| **Adimlar** | 1) 95 normal + 5 yavas client bagla 2) Hizli client'larin latency'sini izle 3) Yavas client'larin dusup dusmedegini kontrol et |
| **Metrikler** | Hizli client p95/p99 latency, yavas client drop orani, server bellek |
| **Beklenen sonuc** | SSE: `res.write()` false dondugunde client duser. WS: `bufferedAmount` izlenebilir |

---

## KATEGORI 5: PROTOKOL OVERHEAD TESTLERI

### TC-15: Framing Overhead Karsilastirmasi

| Alan | Detay |
|------|-------|
| **Kategori** | Protocol Overhead |
| **Aciklama** | Wire uzerindeki gercek byte miktarini karsilastirma |
| **Setup** | 1 client, 100 mesaj, 64B payload |
| **Adimlar** | 1) tcpdump/Wireshark ile wire traffic yakala 2) Protokol basliklarini analiz et |
| **Metrikler** | Toplam wire byte, overhead orani (protocol bytes / payload bytes) |
| **Beklenen sonuc** | WS: 2-14B frame header. SSE: `data: `(6B) + `\n\n`(2B) + HTTP chunked encoding. Kucuk mesajlarda WS hafif avantajli |

### TC-16: Ilk Baglanti Maliyeti (Handshake)

| Alan | Detay |
|------|-------|
| **Kategori** | Protocol Overhead - Setup |
| **Aciklama** | Ilk baglantidan ilk mesaja kadar gecen sure |
| **Setup** | 500 sira ile baglanti, her birinin connection→firstMessage suresini olc |
| **Metrikler** | First-message latency p50/p95/p99 |
| **Beklenen sonuc** | WS: HTTP Upgrade + 101 Switching Protocols + frame negotiation. SSE: HTTP GET + streaming response. SSE hafif avantajli |

---

## KATEGORI 6: GERCEK DUNYA SENARYOLARI

### TC-17: Canli Dashboard (SSE AVANTAJI)

| Alan | Detay |
|------|-------|
| **Kategori** | Real-World |
| **Aciklama** | 1000 kullanici monitoring dashboard'u izliyor (server→client push, interaksiyon yok) |
| **Setup** | 1000 pasif client, 2 msg/sec, 256B (JSON metrikleri), 60 saniye |
| **Adimlar** | 1) Sunucu dashboard metrigini broadcast eder 2) Client'lar sadece alir |
| **Metrikler** | Delivery latency, bellek, CPU, dropped connections |
| **Beklenen sonuc** | **SSE avantajli** (tek yonlu push icin tasarlanmis, proxy/CDN uyumlu, auto-reconnect) |

### TC-18: Borsa Ticker (SSE AVANTAJI)

| Alan | Detay |
|------|-------|
| **Kategori** | Real-World |
| **Aciklama** | Yuksek frekanslı fiyat guncellemeleri, cok sayida pasif tuketici |
| **Setup** | 5000 client, 20 msg/sec, 128B (fiyat verisi), 60 saniye |
| **Metrikler** | p99 latency, delivery ratio, bellek/baglanti, CPU |
| **Beklenen sonuc** | **SSE avantajli** (one-way high-frequency push, CDN onbelleklenebilir) |

### TC-19: Chat Uygulamasi (WEBSOCKET AVANTAJI)

| Alan | Detay |
|------|-------|
| **Kategori** | Real-World |
| **Aciklama** | Cift yonlu sohbet: her kullanici mesaj gonderir ve alir |
| **Setup** | 200 client, her biri 0.5 msg/sec yukari, server herkese broadcast, 60 saniye |
| **Metrikler** | Round-trip latency, upstream POST overhead (SSE), CPU |
| **Beklenen sonuc** | **WebSocket kesin kazanir** (native bidirectional, SSE her mesaj icin HTTP POST gerektirir) |

### TC-20: Oyun State Sync (WEBSOCKET AVANTAJI)

| Alan | Detay |
|------|-------|
| **Kategori** | Real-World |
| **Aciklama** | Yuksek frekanslı cift yonlu state senkronizasyonu |
| **Setup** | 50 client, server 60Hz broadcast, client 30Hz input, 30 saniye |
| **Metrikler** | p99 latency (<10ms hedef), event loop lag, client upstream delivery |
| **Beklenen sonuc** | **WebSocket kesin kazanir**. SSE 30 POST/sec/client'i kaldiramaz |

### TC-21: Bildirim Sistemi (SSE AVANTAJI)

| Alan | Detay |
|------|-------|
| **Kategori** | Real-World |
| **Aciklama** | Dusuk frekanslı push bildirimler, cok sayida kullanici |
| **Setup** | 10000 client, 0.1 msg/sec (6 saniyede 1), 128B, 120 saniye |
| **Metrikler** | Bellek/baglanti, idle state CPU, reconnection davranisi |
| **Beklenen sonuc** | **SSE avantajli** (idle state'te daha az overhead, auto-reconnect, HTTP uyumlu) |

---

## KATEGORI 7: HTTP/2 VE ALTYAPI TESTLERI

### TC-22: HTTP/2 Multiplexing (SSE AVANTAJI)

| Alan | Detay |
|------|-------|
| **Kategori** | Infrastructure |
| **Aciklama** | HTTP/2 uzerinde SSE stream'leri tek TCP baglantisinda multiplexlenir |
| **Setup** | nginx HTTP/2 proxy arkasinda 100 SSE client vs 100 WS client |
| **Metrikler** | Toplam TCP baglantisi (FD sayisi), connection setup toplam suresi, bellek |
| **Beklenen sonuc** | **SSE kesin kazanir**. 100 SSE stream ~1 TCP baglantisinda. 100 WS = 100 TCP baglantisi |
| **Gerekli degisiklik** | `sse-server-h2.js` olustur, nginx HTTP/2 config |

### TC-23: Proxy/CDN Uyumlulugu

| Alan | Detay |
|------|-------|
| **Kategori** | Infrastructure |
| **Aciklama** | Cesitli reverse proxy'ler arkasinda calisma (nginx, HAProxy, Cloudflare) |
| **Setup** | Nitel karsilastirma + nginx arkasinda latency testi |
| **Metrikler** | Uyumluluk matrisi, proxy arkasinda ek latency |
| **Beklenen sonuc** | **SSE kesin kazanir**. Standart HTTP, ozel config gerektirmez. WS upgrade desteigi gerektirir |

---

## TEST YURUTME MATRISI

Tam test listesi (her satir bir calistirma):

| # | Test | Protokol | Client | Rate | Boyut | Sure | Mod | Ana Metrik |
|---|------|----------|--------|------|-------|------|-----|------------|
| 1 | Baseline latency | WS | 100 | 1 | 64B | 30s | latency | p50/p95/p99 |
| 2 | Baseline latency | SSE | 100 | 1 | 64B | 30s | latency | p50/p95/p99 |
| 3 | Yuk altinda latency | WS | 1000 | 50 | 64B | 30s | latency | p99, CPU |
| 4 | Yuk altinda latency | SSE | 1000 | 50 | 64B | 30s | latency | p99, CPU |
| 5 | Echo round-trip | WS | 100 | 10/s | 64B | 30s | echo | RT p99 |
| 6 | Echo round-trip | SSE | 100 | 10/s | 64B | 30s | echo | RT p99 |
| 7 | Chat sim. | WS | 200 | 1/client | 64B | 30s | chat | delivery lat |
| 8 | Chat sim. | SSE | 200 | 1/client | 64B | 30s | chat | delivery lat |
| 9 | Max throughput | WS | 100 | ramp | 64B | 60s | throughput | delivery% |
| 10 | Max throughput | SSE | 100 | ramp | 64B | 60s | throughput | delivery% |
| 11 | Large payload | WS | 100 | 1 | sweep | 60s | payload-sweep | MB/s |
| 12 | Large payload | SSE | 100 | 1 | sweep | 60s | payload-sweep | MB/s |
| 13 | Binary data | WS | 100 | 10 | 4KB | 30s | binary | throughput |
| 14 | Binary data | SSE | 100 | 10 | 4KB | 30s | binary | throughput |
| 15 | Fan-out scale | WS | 10000 | 1 | 64B | - | scalability | mem/conn |
| 16 | Fan-out scale | SSE | 10000 | 1 | 64B | - | scalability | mem/conn |
| 17 | Conn cost | WS | 1 | - | - | - | conn-cost | setup p99 |
| 18 | Conn cost | SSE | 1 | - | - | - | conn-cost | setup p99 |
| 19 | Reconnection | WS | 100 | 1 | 64B | 60s | reconnect | recovery ms |
| 20 | Reconnection | SSE | 100 | 1 | 64B | 60s | reconnect | recovery ms |
| 21 | Churn | WS | 500 | 1 | 64B | 60s | churn | mem growth |
| 22 | Churn | SSE | 500 | 1 | 64B | 60s | churn | mem growth |
| 23 | Soak test | WS | 200 | 1 | 64B | 30m | broadcast | mem leak |
| 24 | Soak test | SSE | 200 | 1 | 64B | 30m | broadcast | mem leak |
| 25 | Backpressure | WS | 100 | 10 | 64B | 30s | backpressure | fast-client lat |
| 26 | Backpressure | SSE | 100 | 10 | 64B | 30s | backpressure | fast-client lat |
| 27 | Dashboard sim | WS | 1000 | 2 | 256B | 60s | broadcast | delivery lat |
| 28 | Dashboard sim | SSE | 1000 | 2 | 256B | 60s | broadcast | delivery lat |
| 29 | Stock ticker | WS | 5000 | 20 | 128B | 60s | broadcast | p99, CPU |
| 30 | Stock ticker | SSE | 5000 | 20 | 128B | 60s | broadcast | p99, CPU |
| 31 | Game sync | WS | 50 | 60 | 64B | 30s | echo | p99 <10ms |
| 32 | Game sync | SSE | 50 | 60 | 64B | 30s | echo | p99 <10ms |
| 33 | Notification | WS | 10000 | 0.1 | 128B | 120s | broadcast | mem/conn |
| 34 | Notification | SSE | 10000 | 0.1 | 128B | 120s | broadcast | mem/conn |

---

## BEKLENEN SONUC OZETI

| Boyut | WebSocket Kazanir | SSE Kazanir | Esit |
|-------|-------------------|-------------|------|
| Cift yonlu latency | **Guclu** (native upstream) | | |
| Chat / interaktif | **Guclu** (ayni TCP uzerinde bidir.) | | |
| Oyun state sync | **Guclu** (60Hz bidir.) | | |
| Binary veri | **Guclu** (native binary frame) | | |
| Tek yonlu broadcast | | | ~Esit |
| Otomatik reconnect | | **Guclu** (Last-Event-ID) | |
| HTTP/2 multiplexing | | **Guclu** (tek TCP) | |
| Proxy/CDN uyumu | | **Guclu** (standart HTTP) | |
| Baglanti basina bellek | | **Hafif** (daha az state) | |
| Buyuk fan-out (5000+) | | **Hafif** (basit write path) | |
| Broadcast CPU/msg | | **Hafif** (frame masking yok) | |
| Baglanti kurulumu | | **Hafif** (upgrade yok) | |
| Max baglanti siniri | | | ~Esit (FD siniri) |
| Buyuk payload (text) | | | ~Esit |
| Bildirim sistemi | | **Avantajli** (idle overhead az) | |

---

## GEREKLI KOD DEGISIKLIKLERI

### 1. metrics.js - Kritik

- [ ] **Percentile tracking** ekle (p50/p95/p99) - circular buffer veya sorted array
- [ ] **External memory** (`process.memoryUsage().external`) ekle
- [ ] **Baseline RSS** kaydet (baglanti oncesi)
- [ ] **msg/sec sliding window** (sifirlanmayan ring buffer)
- [ ] **Baglanti suresi tracking** ekle
- [ ] **Bandwidth (bytes/sec)** olcumu ekle
- [ ] **GC metrikleri** (`perf_hooks` PerformanceObserver)
- [ ] **Event loop lag** icin `monitorEventLoopDelay()` kullan

### 2. websocket-server.js

- [ ] `--mode=echo` ekle (gelen mesaji aninda geri gonder)
- [ ] `bufferedAmount` izleme ekle
- [ ] `POST /reset` endpoint ekle
- [ ] `POST /disconnect-all` endpoint ekle
- [ ] `POST /config` endpoint ekle (rate + size + binary)
- [ ] Binary frame broadcast desteigi ekle

### 3. sse-server.js

- [ ] `id:` field ekle (incrementing event ID)
- [ ] `Last-Event-ID` header destegi + mesaj ring buffer
- [ ] `retry:` field ekle
- [ ] `POST /reset` endpoint ekle
- [ ] `POST /disconnect-all` endpoint ekle
- [ ] `POST /config` endpoint ekle
- [ ] `res.socket.setNoDelay(true)` ekle (Nagle disable - WS ile esit sartlar)
- [ ] Binary → Base64 encoding desteigi ekle

### 4. client-simulator.js

- [ ] **Percentile hesaplama** ekle (p50/p95/p99)
- [ ] `--mode=echo` ekle (round-trip olcum)
- [ ] `--mode=churn` ekle (surekli baglan/kopar)
- [ ] `--mode=reconnect` ekle (kopma sonrasi recovery)
- [ ] `--mode=throughput` ekle (rate ramp-up)
- [ ] `--mode=payload-sweep` ekle (boyut kademeli artis)
- [ ] `--mode=connection-cost` ekle (handshake olcum)
- [ ] `--mode=binary` ekle (binary veri testi)
- [ ] `--output=results.json` flag ekle (yapilandirilmis JSON cikti)
- [ ] SSE 2000 baglanti sinirini konfigure edilebilir yap
- [ ] `--echo-rate=N` flag ekle
- [ ] 5 saniye aralikla timeline veri toplama ekle

### 5. Yeni Dosyalar

- [ ] `load-test/run-benchmarks.sh` - Otomasyon script'i (quick/standard/comprehensive profiller)
- [ ] `load-test/compare-results.js` - Sonuc karsilastirma araci
- [ ] `server/sse-server-h2.js` - HTTP/2 SSE sunucusu

---

## ADIL KARSILASTIRMA UYARILARI

1. **Express asimetrisini gider**: SSE Express kullanir, WS raw http. Ya WS'ye de Express ekle ya da SSE'den cikar
2. **Nagle algoritmasini tutarli yap**: WS `setNoDelay(true)` kullaniyor, SSE kullanmiyor. Bu tek basina 40ms fark yaratabilir
3. **`Date.now()` clock skew**: Tum testler localhost'ta yapilmali. Remote testler icin NTP veya round-trip kullan
4. **Her testi 3+ kez calistir**, median raporla. 10 saniye warmup her testten once
5. **SSE latency raporlama overhead'i**: POST /latency ek HTTP baglantisi olusturur. Broadcast testlerde devre disi birak
6. **Tarayici SSE limitini belirt**: 6 baglanti limiti HTTP/1.1 artefakti, protokol siniri degil
