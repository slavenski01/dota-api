package local.dota.parser

/** Source 2 network origin, verified against static landmarks (docs/map-calibration.md).
 * Parented entities need a transform we do not have. Never replace missing X/Y with zero.
 * The background version is a viewer concern, not the replay's unknown patch. */
internal fun worldPosition(parent: Number?, cellX: Number?, x: Number?, cellY: Number?, y: Number?,
                           cellZ: Number?, z: Number?): Map<String, Any?>? {
    if (parent?.toDouble() != 0xFFFFFF.toDouble()) return null
    val worldX = coordinateCandidate(cellX, x) ?: return null
    val worldY = coordinateCandidate(cellY, y) ?: return null
    return mapOf("x" to worldX, "y" to worldY, "z" to coordinateCandidate(cellZ, z),
        "coordinateSystem" to "world", "mapVersion" to null)
}
