use vibe_cs_source_assets::Cs2AssetStore;

fn main() {
    let root = std::env::args().nth(1).expect("CS2 installation root");
    let locale = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "en-US".to_owned());
    let store = Cs2AssetStore::open(root).expect("open asset store");
    let catalog = store.cosmetic_catalog_for_locale(&locale).expect("catalog");
    println!(
        "catalog items={} paints={} ak47={} ak47_paints={}",
        catalog.items.len(),
        catalog.paint_kits.len(),
        catalog
            .item(7)
            .map_or("missing", |item| item.display_name.as_str()),
        catalog.item(7).map_or(0, |item| item.paint_kit_ids.len())
    );
    if let Some(image_path) = catalog.item(7).and_then(|item| {
        item.paint_kit_ids
            .first()
            .and_then(|paint| catalog.image_path(7, *paint))
    }) {
        let first_paint = catalog
            .item(7)
            .and_then(|item| item.paint_kit_ids.first())
            .and_then(|paint| catalog.paint_kit(*paint))
            .map_or("missing", |paint| paint.display_name.as_str());
        let decoded = store
            .cosmetic_image(image_path)
            .expect("decode cosmetic image");
        println!(
            "decoded {} ({}) {}x{} {} bytes {}",
            image_path,
            first_paint,
            decoded.width,
            decoded.height,
            decoded.bytes.len(),
            decoded.mime_type
        );
    }
}
