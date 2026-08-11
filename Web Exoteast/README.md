# Exoteast — Aplikasi Kelola Gerobak

Aplikasi manajemen internal untuk bisnis minuman keliling Exoteast: login
Admin/Owner, pemasukan harian per lokasi (Reguler / Night Market) dengan
staff driver wajib dipilih, penjualan per driver, pengeluaran per barang
(otomatis terhitung), inventori, gaji karyawan (driver & staff dapur),
dashboard dengan grafik harian & bulanan, dan laporan bulanan lengkap yang
bisa dicetak atau diunduh sebagai Excel.

## 🔑 Login & Peran Akun

Saat pertama kali dibuka, aplikasi otomatis membuat 2 akun demo:

| Peran | Username | Password | Akses |
|---|---|---|---|
| Admin | `admin` | `admin123` | Semua halaman, dapat mengedit semua data |
| Owner/Investor | `owner` | `owner123` | Hanya Dashboard & Laporan, **tidak bisa mengedit** |

Segera ganti password lewat menu **Kelola Akun** (khusus Admin) setelah
login pertama. Admin juga bisa menambah akun Owner/Investor lain, atau
akun Admin tambahan, dari menu yang sama.

## 👷 Driver vs Staff Dapur

Saat menambah karyawan di menu **Karyawan**, pilih Jenis Staff:

- **🚚 Driver** — punya target harian, akan muncul di dropdown "Nama Staff"
  saat mencatat Pemasukan Harian (lokasi Reguler wajib pilih driver), dan
  masuk ke Peringkat Driver di Dashboard & Laporan.
- **🍳 Staff Dapur** — tidak punya target harian, tidak muncul di form
  Pemasukan Harian, cukup terdaftar di menu Karyawan untuk dihitung gajinya.

## 💸 Pengeluaran

Setiap pengeluaran dicatat dengan Nama Barang, Jumlah, dan Harga Satuan —
Total dihitung otomatis (Jumlah × Harga Satuan).

## 🧾 Laporan

Laporan bulanan sekarang terbagi rapi: Ringkasan (bisa dicetak), Detail
Pemasukan, Detail Pengeluaran, Peringkat Driver, dan Data Master (Varian &
Karyawan). Tombol **Export Excel** mengunduh file `.xlsx` berisi semua
sheet tersebut sekaligus.

## 📊 Dashboard

Dashboard menampilkan grafik garis pemasukan vs pengeluaran harian untuk
bulan berjalan, dan grafik batang tren bulanan 6 bulan terakhir — selain
kartu ringkasan, riwayat 7 hari terakhir, varian terlaris, peringkat
driver, dan status stok.

## 📁 Struktur Folder

```
exoteast/
├── index.html        ← halaman utama, buka file ini di browser
├── css/
│   └── style.css     ← semua styling & warna
├── js/
│   └── app.js         ← semua logika aplikasi (termasuk login & role)
├── image/
│   ├── logo.png        ← logo Exoteast (background transparan)
│   ├── gerobak.jpg      ← foto gerobak (banner dashboard)
│   ├── es-teh.jpg
│   ├── es-kopi.jpg
│   ├── es-matcha.jpg
│   └── es-stroberi.jpg  ← foto produk (galeri di halaman Varian Minuman)
└── README.md
```

## ▶️ Cara Menjalankan

Cukup buka `index.html` langsung di browser (double-click), atau untuk hasil
terbaik jalankan lewat local server sederhana, misalnya:

```bash
cd exoteast
python3 -m http.server 8000
# lalu buka http://localhost:8000
```

> Grafik (Chart.js) & export Excel (SheetJS) dimuat dari CDN, jadi
> perangkat perlu koneksi internet saat menggunakan fitur tersebut.

## ✏️ Cara Mengedit

- **Warna & tampilan** → edit `css/style.css`. Semua warna brand diatur lewat
  variabel di bagian paling atas (`:root { --primary: ...; }`), jadi tinggal
  ganti satu tempat untuk mengubah keseluruhan tema.
- **Logika / fitur / akun default** → edit `js/app.js`.
- **Gambar** → ganti file di folder `image/` dengan nama file yang sama, atau
  ganti nama filenya lalu sesuaikan juga path-nya di `index.html` / `js/app.js`
  (cari kata `image/`).
- **Struktur halaman (login, sidebar)** → edit `index.html`.

## 💾 Penyimpanan Data

Aplikasi ini secara otomatis mendeteksi tempat ia dijalankan:

- Jika dibuka sebagai Artifact di **Claude.ai**, data disimpan lewat sistem
  penyimpanan Claude (`window.storage`) — termasuk daftar akun login.
- Jika dibuka sebagai **website mandiri** (di browser langsung atau di-hosting
  sendiri), data otomatis disimpan di **localStorage** browser milikmu.

Sesi login yang sedang aktif disimpan terpisah di `sessionStorage` browser
(hilang otomatis saat tab ditutup) — ini bukan bagian dari data bisnis.

Kedua mode penyimpanan data bisnis memakai kode yang sama persis — tidak
perlu pengaturan tambahan. Catatan: localStorage tersimpan per-browser/
per-perangkat, jadi data tidak otomatis sinkron antar perangkat kalau
di-hosting sebagai website biasa.

## 🌐 Deploy sebagai Website

Karena ini murni HTML/CSS/JS statis (tanpa backend), kamu bisa upload seluruh
folder `exoteast/` ini ke layanan hosting statis apa saja, misalnya:
Netlify, Vercel, GitHub Pages, atau cPanel hosting biasa.

⚠️ Catatan keamanan: sistem login ini dirancang untuk kontrol akses
sederhana di aplikasi internal (memisahkan siapa yang boleh mengedit vs
hanya melihat), bukan otentikasi tingkat enterprise — password tersimpan
apa adanya di penyimpanan data. Untuk data sensitif/publik, pertimbangkan
menambahkan backend & otentikasi yang lebih kuat.
