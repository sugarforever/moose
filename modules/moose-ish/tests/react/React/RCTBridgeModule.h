#import <Foundation/Foundation.h>
typedef void (^RCTPromiseResolveBlock)(id);
typedef void (^RCTPromiseRejectBlock)(NSString *, NSString *, NSError *);
@protocol RCTBridgeModule @end
#define RCT_EXPORT_MODULE(name)
#define RCT_REMAP_METHOD(name, signature) - (void)signature
