#import "WidgetReloader.h"

// Declared in WidgetReloaderBridge.swift (compiled into same target)
extern void NexusReloadAllWidgets(void);

@implementation WidgetReloader

RCT_EXPORT_MODULE();

RCT_EXPORT_METHOD(reloadAll:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NexusReloadAllWidgets();
  resolve(nil);
}

+ (BOOL)requiresMainQueueSetup { return NO; }

@end
