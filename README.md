# bay4lly Kettu Plugins

Kettu için hazırlanmış mobil Discord eklentileri. Her plugin ayrı klasördedir ve istediğini tek tek kurabilirsin.

**Geliştirici: bay4lly**

## Pluginler

| Plugin | Ne işe yarar? |
|---|---|
| Translate | Mesajları elle veya otomatik çevirir. |
| BetterNotifications | Bildirimleri kullanıcı, kanal, mention ve kelimelere göre filtreler. |
| BetterTyping | Kim yazıyor ve ne kadar süredir yazıyor gösterir; kendi typing bilgisini gizleme seçeneği sunar. |
| AccountSwitcher+ | Mobilde kayıtlı hesaplar arasında çıkış yapmadan hızlı geçiş sağlar. |
| ChannelTabs | Kanal ve DM'leri üstte hızlı sekmeler halinde tutar. |
| BetterStatus | Hazır durum presetleri oluşturup tek dokunuşla uygular. |
| ImageTools | Avatar, emoji, sticker, GIF ve mesaj medyası için aç/kaydet/link araçları ekler. |
| GhostPingLogger | Mention atılıp silinen mesajları yerel olarak kaydeder. |
| MessageLogger | Silinen mesajları ve düzenleme geçmişini sohbet içinde gösterir. |
| FakeNitro | Emoji/sticker bağlantı fallback'i ve desteklenen bazı Nitro arayüz seçeneklerini açmayı dener. |

## Kurulum mantığı

Bu repository GitHub Pages ile yayınlanır. Sonra Kettu'ya her pluginin **klasör adresi** eklenir. Örneğin repo adresin `https://bay4lly.github.io/kettu-plugins/` ise MessageLogger adresi:

```text
https://bay4lly.github.io/kettu-plugins/MessageLogger/
```

Translate adresi:

```text
https://bay4lly.github.io/kettu-plugins/Translate/
```

Aynı mantık diğer klasörler için de geçerlidir. `index.js` veya `manifest.json` adresini tek başına Kettu'ya verme.

## Önerilen kullanım

Pluginleri birer birer kurup Discord'u yeniden başlatmak sorun çıkarsa hangi pluginin sebep olduğunu bulmayı kolaylaştırır. MessageLogger ile FakeNitro birlikte kullanılabilir, ancak Discord güncellemeleri mobil arayüzün iç yapısını değiştirebildiği için bazı görsel özellikler sürüme göre yeniden uyarlama isteyebilir.

## Güvenlik

Bu projedeki dosyaları kendi GitHub Pages adresinden yayınlamak en temiz yoldur. Özellikle AccountSwitcher+ gibi oturum bilgileriyle çalışan bir eklentiyi rastgele yeniden paketlenmiş APK/plugin sitelerinden kurma.

Bazı pluginler başka açık kaynak projelerdeki fikirlerden veya uyumluluk çalışmalarından yararlanır. Gerekli kaynak ve lisans bilgileri ilgili plugin klasörlerindeki `SOURCES.md` ve `LICENSE` dosyalarında korunur.
