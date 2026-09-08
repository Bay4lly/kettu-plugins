# Kaynaklar ve port notları

Kontrol tarihi: 2026-09-08

## Vencord FakeNitro

- Upstream: https://github.com/Vendicated/Vencord/tree/main/src/plugins/fakeNitro
- Ana kaynak: https://github.com/Vendicated/Vencord/blob/main/src/plugins/fakeNitro/index.tsx
- Lisans: GPL-3.0-or-later

Upstream'tan davranış olarak referans alınan başlıca alanlar:

- Kullanılamayan emoji için Discord CDN URL fallback'i.
- Kullanılamayan sticker için Discord media URL fallback'i.
- Hyperlink text / boyut ayarları.
- `canUseCustomStickersEverywhere`, `canUseHighVideoUploadQuality`, `canStreamQuality`, `canUseClientThemes`, `canUsePremiumAppIcons` gibi istemci capability kontrollerinin açılması.
- Soundboard availability fikri.

Vencord sürümü masaüstü Discord webpack source replacement, DOM, Canvas ve MessageEventsAPI kullanıyor. Kettu Android React Native'de bunların aynısı bulunmadığından bu port runtime monkey-patching ile yeniden yazıldı.

## Kettu

- Repo: https://github.com/C0C0B01/Kettu
- Legacy plugin loader: `src/core/vendetta/plugins.ts`
- Vendetta compatibility API: `src/core/vendetta/api.tsx`
- Patcher: `src/lib/api/patcher.ts`

Kullanılan Kettu API yüzeyi:

- `vendetta.metro.findByProps`
- `vendetta.metro.findByPropsAll`
- `vendetta.metro.findByStoreName`
- `vendetta.metro.common`
- `vendetta.patcher.before`
- `vendetta.patcher.after`
- `vendetta.patcher.instead`
- `vendetta.plugin.storage`

## Kettu için mevcut plugin araştırması

Kettu'nun kendisi ve güncel Kettu/Revenge/Vendetta plugin koleksiyonlarında yapılan aramalarda, bu port hazırlanırken açıkça bakımı yapılan ayrı bir **Kettu FakeNitro** pluginine rastlanmadı. Bu yüzden Vencord davranışı Kettu API'lerine yeniden uygulanmıştır.

Bu ifade "internette hiçbir yerde yok" iddiası değildir; yalnızca kontrol edilen güncel public kaynaklarda bakımlı bir Kettu portu bulunmadığını belirtir.
