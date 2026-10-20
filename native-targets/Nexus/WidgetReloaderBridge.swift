import WidgetKit

/// Called from WidgetReloader.m via extern C linkage.
/// Pure Swift — no RCT types needed here.
@_cdecl("NexusReloadAllWidgets")
func nexusReloadAllWidgets() {
  if #available(iOS 14.0, *) {
    WidgetCenter.shared.reloadAllTimelines()
  }
}
