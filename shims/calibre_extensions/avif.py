# avif — placeholder for the Qt AVIF image-format plugin. On desktop this
# registers AVIF support with Qt's image system; in the wasm build there is
# no Qt. Image decode goes through Pillow (which has no AVIF either — AVIF
# inputs simply fail image_from_data, matching the "unsupported image"
# behavior). Exists so `from calibre_extensions import avif` in
# calibre.utils.img does not ImportError at module level.

registered_formats = ()
