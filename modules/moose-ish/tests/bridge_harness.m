// Executes the production bridge with only React's registration layer substituted.
#import "../ios/MooseISH.m"
static NSUInteger eventBytes;
@implementation RCTEventEmitter
- (void)invalidate {}
- (void)sendEventWithName:(NSString *)name body:(id)body { eventBytes += [[NSData alloc] initWithBase64EncodedString:body[@"data"] options:0].length; }
@end
static void fail(NSString *message) { fprintf(stderr,"%s\n",message.UTF8String);exit(1); }
static id waitResult(void (^operation)(RCTPromiseResolveBlock,RCTPromiseRejectBlock)) {
  dispatch_semaphore_t sem=dispatch_semaphore_create(0);__block id value=nil;__block NSString *failure=nil;
  operation(^(id result){value=result;dispatch_semaphore_signal(sem);},^(NSString *code,NSString *message,NSError *error){failure=code;dispatch_semaphore_signal(sem);});
  if(dispatch_semaphore_wait(sem,dispatch_time(DISPATCH_TIME_NOW,30*NSEC_PER_SEC)))fail(@"bridge timed out");
  if(failure)fail(failure);return value;
}
int main(int argc,char **argv) {
 @autoreleasepool {
  if(argc!=2){fprintf(stderr,"usage: bridge-harness fakefs-root\n");return 2;}
  NSString *seed=[NSString stringWithUTF8String:argv[1]];
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT,0),^{@autoreleasepool {
   NSString *base=[NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
   MooseISH *bridge=[[MooseISH alloc] initWithBase:base];
   [[NSFileManager defaultManager] createDirectoryAtPath:[base stringByAppendingPathComponent:@"test"] withIntermediateDirectories:YES attributes:nil error:nil];
   NSError *error=nil;[[NSFileManager defaultManager] copyItemAtPath:seed toPath:[bridge rootFor:@"test"] error:&error];if(error)fail(error.description);
   NSDictionary *result=waitResult(^(RCTPromiseResolveBlock resolve,RCTPromiseRejectBlock reject){[bridge execute:@"test" commandId:@"one" argv:@[@"/bin/sh",@"-c",@"cat; printf err >&2; exit 7"] cwd:@"/" env:@{} inputBase64:[[@"bytes" dataUsingEncoding:NSUTF8StringEncoding] base64EncodedStringWithOptions:0] timeoutMs:@5000 resolver:resolve rejecter:reject];});
   if([result[@"exitCode"] intValue]!=7)fail(@"exit code");
   if(![[[NSData alloc] initWithBase64EncodedString:result[@"stdout"] options:0] isEqual:[@"bytes" dataUsingEncoding:NSUTF8StringEncoding]])fail(@"stdin/stdout");
   if(![[[NSData alloc] initWithBase64EncodedString:result[@"stderr"] options:0] isEqual:[@"err" dataUsingEncoding:NSUTF8StringEncoding]])fail(@"stderr");
   if(eventBytes!=8)fail(@"stream events must precede settlement");
   NSMutableData *large=[NSMutableData dataWithLength:8*1024*1024];memset(large.mutableBytes,0xa5,large.length);
   fprintf(stderr,"bridge large transfer start\n");
   NSDictionary *transfer=waitResult(^(RCTPromiseResolveBlock resolve,RCTPromiseRejectBlock reject){[bridge execute:@"test" commandId:@"large" argv:@[@"/bin/cat"] cwd:@"/" env:@{} inputBase64:[large base64EncodedStringWithOptions:0] timeoutMs:@10000 resolver:resolve rejecter:reject];});
   if(![[[NSData alloc] initWithBase64EncodedString:transfer[@"stdout"] options:0] isEqual:large])fail(@"8MiB binary transfer");
   fprintf(stderr,"bridge timeout start\n");
   NSDictionary *timeout=waitResult(^(RCTPromiseResolveBlock resolve,RCTPromiseRejectBlock reject){[bridge execute:@"test" commandId:@"timeout" argv:@[@"/bin/sh",@"-c",@"sleep 20"] cwd:@"/" env:@{} inputBase64:@"" timeoutMs:@100 resolver:resolve rejecter:reject];});
   if(![timeout[@"timedOut"] boolValue])fail(@"timeout status");
   double cancelStart=[NSDate timeIntervalSinceReferenceDate];
   NSDictionary *directSleep=waitResult(^(RCTPromiseResolveBlock resolve,RCTPromiseRejectBlock reject){[bridge execute:@"test" commandId:@"direct-sleep" argv:@[@"/bin/sleep",@"2"] cwd:@"/" env:@{} inputBase64:@"" timeoutMs:@5000 resolver:resolve rejecter:reject];usleep(50000);[bridge cancel:@"direct-sleep" resolver:^(id value){} rejecter:reject];});
   if(![directSleep[@"cancelled"] boolValue] || [NSDate timeIntervalSinceReferenceDate]-cancelStart>=1.0)fail(@"direct sleep cancellation must complete within one second");
   fprintf(stderr,"bridge flood start\n");
   NSDictionary *flood=waitResult(^(RCTPromiseResolveBlock resolve,RCTPromiseRejectBlock reject){[bridge execute:@"test" commandId:@"flood" argv:@[@"/bin/sh",@"-c",@"yes x"] cwd:@"/" env:@{} inputBase64:@"" timeoutMs:@10000 resolver:resolve rejecter:reject];});
   if(![flood[@"omittedBytes"] unsignedLongLongValue] || [[NSData alloc] initWithBase64EncodedString:flood[@"stdout"] options:0].length>16*1024*1024)fail(@"output flood bound");
   waitResult(^(RCTPromiseResolveBlock resolve,RCTPromiseRejectBlock reject){[bridge cancel:@"precancel" resolver:resolve rejecter:reject];});
   NSDictionary *cancelled=waitResult(^(RCTPromiseResolveBlock resolve,RCTPromiseRejectBlock reject){[bridge execute:@"test" commandId:@"precancel" argv:@[@"/bin/sleep",@"20"] cwd:@"/" env:@{} inputBase64:@"" timeoutMs:@5000 resolver:resolve rejecter:reject];});
   if(![cancelled[@"cancelled"] boolValue])fail(@"pre-register cancel lost");
   bridge.coordinator.journalUsable=NO;__block BOOL failClosed=NO;
   [bridge execute:@"test" commandId:@"corrupt" argv:@[@"/bin/true"] cwd:@"/" env:@{} inputBase64:@"" timeoutMs:@5000 resolver:^(id value){fail(@"journal failure replayed");} rejecter:^(NSString *code,NSString *message,NSError *error){failClosed=[code isEqual:@"journal_failed"];}];
   if(!failClosed)fail(@"corrupt journal must fail closed");bridge.coordinator.journalUsable=YES;
   NSMutableArray *admitted=[NSMutableArray new];
   NSMutableData *sixteen=[NSMutableData dataWithLength:16*1024*1024];NSString *sixteen64=[sixteen base64EncodedStringWithOptions:0];
   for(int i=0;i<2;i++){
    dispatch_semaphore_t done=dispatch_semaphore_create(0);[admitted addObject:done];NSString *identifier=[NSString stringWithFormat:@"admit-bytes-%d",i];
    [bridge execute:@"test" commandId:identifier argv:@[@"/bin/sh",@"-c",@"while :; do :; done"] cwd:@"/" env:@{} inputBase64:sixteen64 timeoutMs:@25000 resolver:^(id value){dispatch_semaphore_signal(done);} rejecter:^(NSString *code,NSString *message,NSError *error){fail(code);}];
   }
   __block BOOL byteBusy=NO;
   [bridge execute:@"test" commandId:@"byte-overflow" argv:@[@"/bin/true"] cwd:@"/" env:@{} inputBase64:@"eA==" timeoutMs:@1000 resolver:^(id value){fail(@"stdin admission exceeded");} rejecter:^(NSString *code,NSString *message,NSError *error){byteBusy=[code isEqual:@"spawn_error"];}];
   if(!byteBusy || bridge.coordinator.journal[@"byte-overflow"])fail(@"stdin budget must reject without journaling");
   for(int i=0;i<2;i++)[bridge cancel:[NSString stringWithFormat:@"admit-bytes-%d",i] resolver:^(id v){} rejecter:^(NSString *c,NSString *m,NSError *e){fail(c);}];
   for(dispatch_semaphore_t done in admitted)if(dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,30*NSEC_PER_SEC)))fail(@"admission cancellation");
   [admitted removeAllObjects];
   for(int i=0;i<4;i++){
    dispatch_semaphore_t done=dispatch_semaphore_create(0);[admitted addObject:done];NSString *identifier=[NSString stringWithFormat:@"admit-jobs-%d",i];
    [bridge execute:@"test" commandId:identifier argv:@[@"/bin/sh",@"-c",@"while :; do :; done"] cwd:@"/" env:@{} inputBase64:@"" timeoutMs:@25000 resolver:^(id value){dispatch_semaphore_signal(done);} rejecter:^(NSString *code,NSString *message,NSError *error){fail(code);}];
   }
   MooseISH *capacityGeneration=[[MooseISH alloc] initWithBase:base];
   __block BOOL jobBusy=NO;
   [capacityGeneration execute:@"test" commandId:@"job-overflow" argv:@[@"/bin/true"] cwd:@"/" env:@{} inputBase64:@"" timeoutMs:@1000 resolver:^(id value){fail(@"job admission exceeded");} rejecter:^(NSString *code,NSString *message,NSError *error){jobBusy=[code isEqual:@"spawn_error"];}];
   if(!jobBusy || bridge.coordinator.journal[@"job-overflow"])fail(@"job budget must reject without journaling");
   for(int i=0;i<4;i++)[bridge cancel:[NSString stringWithFormat:@"admit-jobs-%d",i] resolver:^(id v){} rejecter:^(NSString *c,NSString *m,NSError *e){fail(c);}];
   for(dispatch_semaphore_t done in admitted)if(dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,30*NSEC_PER_SEC)))fail(@"job cancellation");
   NSMutableDictionary *previousJournal=bridge.coordinator.journal;bridge.coordinator.journal=[NSMutableDictionary new];
   for(int i=0;i<10000;i++)bridge.coordinator.journal[[NSString stringWithFormat:@"history-%d",i]]=@{@"workspace":@"test",@"status":@"completed",@"exitCode":@0};
   __block BOOL journalFull=NO;
   [bridge execute:@"test" commandId:@"history-overflow" argv:@[@"/bin/true"] cwd:@"/" env:@{} inputBase64:@"" timeoutMs:@1000 resolver:^(id value){fail(@"journal capacity exceeded");} rejecter:^(NSString *code,NSString *message,NSError *error){journalFull=[code isEqual:@"spawn_error"];}];
   if(!journalFull || bridge.coordinator.journal.count!=10000 || bridge.coordinator.journal[@"history-overflow"])fail(@"journal limit must preserve prior IDs without adding rejected ID");bridge.coordinator.journal=previousJournal;
   __block BOOL duplicate=NO;
   [bridge execute:@"test" commandId:@"one" argv:@[@"/bin/true"] cwd:@"/" env:@{} inputBase64:@"" timeoutMs:@5000 resolver:^(id value){fail(@"duplicate replayed");} rejecter:^(NSString *code,NSString *message,NSError *error){duplicate=[code isEqual:@"duplicate_command"];}];
   if(!duplicate)fail(@"missing duplicate rejection");
   NSDictionary *journal=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:bridge.coordinator.journalPath] options:0 error:nil];for(NSDictionary *record in journal.allValues)for(id key in record)if(![@[@"workspace",@"status",@"exitCode"] containsObject:key])fail(@"journal leaked input");
   waitResult(^(RCTPromiseResolveBlock resolve,RCTPromiseRejectBlock reject){[bridge cleanup:@"test" resolver:resolve rejecter:reject];});
   dispatch_semaphore_t oldDone=dispatch_semaphore_create(0),freshDone=dispatch_semaphore_create(0);
   RCTPromiseRejectBlock reloadReject=^(NSString *code,NSString *message,NSError *error){fail(code);};
   [bridge execute:@"test" commandId:@"reload-old" argv:@[@"/bin/sh",@"-c",@"while :; do :; done"] cwd:@"/" env:@{} inputBase64:@"" timeoutMs:@5000 resolver:^(id value){dispatch_semaphore_signal(oldDone);} rejecter:reloadReject];
   MooseISH *fresh=[[MooseISH alloc] initWithBase:base];
   if(![fresh.coordinator.journal[@"reload-old"][@"status"] isEqual:@"running"])fail(@"reload must not mark live old-generation command interrupted");
   [fresh execute:@"test" commandId:@"reload-fresh" argv:@[@"/bin/sh",@"-c",@"printf effect > /workspace/reload-effect; while :; do :; done"] cwd:@"/" env:@{} inputBase64:@"" timeoutMs:@5000 resolver:^(id value){dispatch_semaphore_signal(freshDone);} rejecter:reloadReject];
   [bridge invalidate];
   if(dispatch_semaphore_wait(oldDone,dispatch_time(DISPATCH_TIME_NOW,5*NSEC_PER_SEC)))fail(@"invalidated generation must cancel own command");
   if(dispatch_semaphore_wait(freshDone,dispatch_time(DISPATCH_TIME_NOW,100*NSEC_PER_MSEC))==0)fail(@"invalidating old generation cancelled fresh generation");
   NSDictionary *reloadDisk=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:fresh.coordinator.journalPath] options:0 error:nil];
   if(![reloadDisk[@"reload-fresh"][@"status"] isEqual:@"running"] || !fresh.coordinator.jobs[@"reload-fresh"])fail(@"old completion overwrote fresh-generation command journal");
   __block BOOL invalidated=NO;
   [bridge execute:@"test" commandId:@"invalidated-admission" argv:@[@"/bin/true"] cwd:@"/" env:@{} inputBase64:@"" timeoutMs:@1000 resolver:^(id value){fail(@"invalidated generation admitted command");} rejecter:^(NSString *code,NSString *message,NSError *error){invalidated=[code isEqual:@"spawn_error"];}];
   if(!invalidated || fresh.coordinator.journal[@"invalidated-admission"])fail(@"invalidated admission must have no journal side effect");
   __block BOOL reloadDuplicate=NO;
   [fresh execute:@"test" commandId:@"reload-old" argv:@[@"/bin/true"] cwd:@"/" env:@{} inputBase64:@"" timeoutMs:@1000 resolver:^(id value){fail(@"cross-generation duplicate replayed");} rejecter:^(NSString *code,NSString *message,NSError *error){reloadDuplicate=[code isEqual:@"duplicate_command"];}];
   if(!reloadDuplicate)fail(@"cross-generation duplicate protection");
   [fresh cancel:@"reload-fresh" resolver:^(id value){} rejecter:reloadReject];
   if(dispatch_semaphore_wait(freshDone,dispatch_time(DISPATCH_TIME_NOW,5*NSEC_PER_SEC)))fail(@"fresh generation cancellation");
   [fresh invalidate];[capacityGeneration invalidate];
   fprintf(stdout,"production native bridge: stdin, streams, exit, event ordering, 8MiB binary transfer, timeout, direct-sleep cancellation, flood, admission limits, cross-generation journal/invalidation, stable ID, journal, cleanup passed\n");exit(0);
  }});
  dispatch_main();
 }
}
