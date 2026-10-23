#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <Foundation/Foundation.h>
#include "embedded.h"
#include <math.h>
#include <pthread.h>
#include <poll.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>

static const NSUInteger CaptureLimit = 16 * 1024 * 1024;
static const NSUInteger ActiveJobLimit = 4;
static const NSUInteger RetainedInputLimit = 32 * 1024 * 1024;
static const NSUInteger JournalRecordLimit = 10000;
@interface MooseISHJob : NSObject
@property NSString *identifier;
@property NSString *workspace;
@property NSString *generation;
@property NSData *input;
@property moose_ish_command *command;
@property NSLock *lock;
@property BOOL finished;
@property moose_ish_result result;
@property int inputFD;
@property int outputFD;
@property int errorFD;
@property RCTPromiseResolveBlock resolve;
@property RCTPromiseRejectBlock reject;
@end
@implementation MooseISHJob
@end

@interface MooseISHCoordinator : NSObject
@property NSLock *lock;
@property NSMutableDictionary<NSString *, MooseISHJob *> *jobs;
@property NSMutableDictionary *journal;
@property NSMutableSet<NSString *> *cancelledIDs;
@property NSMutableSet<NSString *> *closing;
@property NSString *base;
@property NSString *journalPath;
@property BOOL journalUsable;
- (instancetype)initWithBase:(NSString *)base;
- (BOOL)saveJournal;
@end
@interface MooseISH : RCTEventEmitter <RCTBridgeModule>
@property MooseISHCoordinator *coordinator;
@property NSString *generation;
@property BOOL invalidated;
- (instancetype)initWithBase:(NSString *)base;
- (void)runJob:(MooseISHJob *)job;
@end

static BOOL validID(id value) {
  if (![value isKindOfClass:NSString.class] || [value length] < 1 || [value length] > 128) return NO;
  static NSCharacterSet *invalid;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ invalid = [[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"] invertedSet]; });
  return [value rangeOfCharacterFromSet:invalid].location == NSNotFound;
}
static BOOL validString(id value, NSUInteger limit) {
  return [value isKindOfClass:NSString.class] && [value lengthOfBytesUsingEncoding:NSUTF8StringEncoding] <= limit && [value rangeOfString:@"\0"].location == NSNotFound;
}
static void *runCore(void *raw) {
  @autoreleasepool {
    MooseISHJob *job = (__bridge_transfer MooseISHJob *)raw;
    moose_ish_result result = {0};
    int rc = moose_ish_command_run(job.command, &result);
    if (rc && !result.error) result.error = rc;
    [job.lock lock]; job.result = result; job.finished = YES; [job.lock unlock];
  }
  return NULL;
}
@interface MooseISHRunner : NSObject
@property MooseISH *bridge;
@property MooseISHJob *job;
@end
@implementation MooseISHRunner
@end
static void *runBridge(void *raw) {
  @autoreleasepool {
    MooseISHRunner *runner = (__bridge_transfer MooseISHRunner *)raw;
    [runner.bridge runJob:runner.job];
  }
  return NULL;
}

@implementation MooseISHCoordinator
- (instancetype)initWithBase:(NSString *)base {
  if ((self = [super init])) {
    _lock = [NSLock new]; _jobs = [NSMutableDictionary new]; _cancelledIDs = [NSMutableSet new]; _closing = [NSMutableSet new];
    _base = [base copy];
    [[NSFileManager defaultManager] createDirectoryAtPath:_base withIntermediateDirectories:YES attributes:@{NSFileProtectionKey:NSFileProtectionCompleteUntilFirstUserAuthentication} error:nil];
    _journalPath = [_base stringByAppendingPathComponent:@"commands.json"];
    NSNumber *journalBytes = [[[NSFileManager defaultManager] attributesOfItemAtPath:_journalPath error:nil] objectForKey:NSFileSize];
    NSData *data = journalBytes.unsignedLongLongValue <= 8 * 1024 * 1024 ? [NSData dataWithContentsOfFile:_journalPath] : nil;
    id decoded = data ? [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingMutableContainers error:nil] : nil;
    _journalUsable = [decoded isKindOfClass:NSDictionary.class] || ![[NSFileManager defaultManager] fileExistsAtPath:_journalPath];
    _journal = [decoded isKindOfClass:NSDictionary.class] ? [decoded mutableCopy] : [NSMutableDictionary new];
    if (_journal.count > JournalRecordLimit) _journalUsable = NO;
    for (NSString *key in [_journal allKeys]) {
      NSDictionary *record = _journal[key];
      if (!validID(key) || ![record isKindOfClass:NSDictionary.class] || !validID(record[@"workspace"]) || ![@[@"running",@"interrupted",@"completed",@"failed"] containsObject:record[@"status"] ?: @""]) { _journalUsable = NO; continue; }
      for (id field in record) if (![@[@"workspace",@"status",@"exitCode"] containsObject:field]) _journalUsable = NO;
      if ([record[@"status"] isEqual:@"running"]) _journal[key] = @{@"workspace":record[@"workspace"] ?: @"", @"status":@"interrupted"};
    }
    if (_journalUsable) [self saveJournal];
  }
  return self;
}
- (BOOL)saveJournal {
  NSData *data = [NSJSONSerialization dataWithJSONObject:self.journal options:0 error:nil];
  return data && [data writeToFile:self.journalPath options:NSDataWritingAtomic error:nil];
}
@end
static MooseISHCoordinator *coordinatorForBase(NSString *base) {
  static NSLock *registryLock;
  static NSMutableDictionary<NSString *, MooseISHCoordinator *> *registry;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ registryLock=[NSLock new]; registry=[NSMutableDictionary new]; });
  NSString *key=[base stringByStandardizingPath];
  [registryLock lock];
  MooseISHCoordinator *coordinator=registry[key];
  if(!coordinator){coordinator=[[MooseISHCoordinator alloc] initWithBase:key];registry[key]=coordinator;}
  [registryLock unlock];
  return coordinator;
}

@implementation MooseISH
RCT_EXPORT_MODULE(MooseISH)
+ (BOOL)requiresMainQueueSetup { return NO; }
- (NSArray<NSString *> *)supportedEvents { return @[@"MooseISHOutput"]; }
- (instancetype)init {
  NSString *support=NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES).firstObject;
  return [self initWithBase:[support stringByAppendingPathComponent:@"MooseISH"]];
}
// Internal initializer lets native tests isolate storage while exercising the same coordinator.
- (instancetype)initWithBase:(NSString *)base {
  if((self=[super init])){_coordinator=coordinatorForBase(base);_generation=NSUUID.UUID.UUIDString;}
  return self;
}
- (void)invalidate {
  [self.coordinator.lock lock];
  self.invalidated=YES;
  for(MooseISHJob *job in self.coordinator.jobs.allValues)
    if([job.generation isEqual:self.generation] && job.command)moose_ish_command_cancel(job.command);
  [self.coordinator.lock unlock];
  [super invalidate];
}
- (BOOL)saveJournal { return [self.coordinator saveJournal]; }
- (NSString *)rootFor:(NSString *)workspace {
  return [[self.coordinator.base stringByAppendingPathComponent:workspace] stringByAppendingPathComponent:@"root"];
}
- (BOOL)prepareRoot:(NSString *)workspace error:(NSError **)error {
  NSString *destination = [self rootFor:workspace];
  NSFileManager *fm = NSFileManager.defaultManager;
  if ([fm fileExistsAtPath:[destination stringByAppendingPathComponent:@"data"]]) return YES;
  NSBundle *bundle = [NSBundle bundleWithPath:[[NSBundle bundleForClass:self.class] pathForResource:@"MooseISHResources" ofType:@"bundle"]];
  NSString *seed = [bundle pathForResource:@"root" ofType:nil];
  if (!seed) { if (error) *error = [NSError errorWithDomain:@"MooseISH" code:1 userInfo:@{NSLocalizedDescriptionKey:@"Embedded rootfs is missing; run prepare:ish and rebuild iOS."}]; return NO; }
  NSString *parent = [destination stringByDeletingLastPathComponent];
  if (![fm createDirectoryAtPath:parent withIntermediateDirectories:YES attributes:nil error:error]) return NO;
  NSString *temporary = [parent stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
  if (![fm copyItemAtPath:seed toPath:temporary error:error]) { [fm removeItemAtPath:temporary error:nil]; return NO; }
  if (![fm moveItemAtPath:temporary toPath:destination error:error]) { [fm removeItemAtPath:temporary error:nil]; return NO; }
  return YES;
}
RCT_REMAP_METHOD(prepare, prepare:(NSString *)workspace resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  if (!validID(workspace)) { reject(@"invalid_argument", @"Invalid workspace ID", nil); return; }
  [self.coordinator.lock lock]; if(self.invalidated){[self.coordinator.lock unlock];reject(@"spawn_error",@"Native bridge generation is invalidated",nil);return;} NSError *error = nil; BOOL ok = [self prepareRoot:workspace error:&error]; [self.coordinator.lock unlock];
  if (ok) resolve(nil); else reject(@"prepare_failed", error.localizedDescription, error);
}
RCT_REMAP_METHOD(commandStatus, commandStatus:(NSString *)identifier resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  if (!validID(identifier)) { reject(@"invalid_argument", @"Invalid command ID", nil); return; }
  [self.coordinator.lock lock]; NSDictionary *record = [self.coordinator.journal[identifier] copy]; [self.coordinator.lock unlock]; resolve(record);
}
RCT_REMAP_METHOD(execute, execute:(NSString *)workspace commandId:(NSString *)identifier argv:(NSArray *)argv cwd:(NSString *)cwd env:(NSDictionary *)env inputBase64:(NSString *)inputBase64 timeoutMs:(NSNumber *)timeout resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  BOOL valid = validID(workspace) && validID(identifier) && [argv isKindOfClass:NSArray.class] && argv.count > 0 && argv.count <= 256 && validString(cwd, 4096) && [cwd hasPrefix:@"/"] && [env isKindOfClass:NSDictionary.class] && env.count <= 256 && [timeout isKindOfClass:NSNumber.class] && isfinite(timeout.doubleValue) && timeout.doubleValue >= 0 && timeout.doubleValue <= 86400000 && floor(timeout.doubleValue) == timeout.doubleValue && validString(inputBase64, 24 * 1024 * 1024);
  if (!valid) { reject(@"invalid_argument", @"Invalid command arguments", nil); return; }
  NSUInteger bytes = 0;
  for (id arg in argv) { valid = valid && validString(arg, 131072); if ([arg isKindOfClass:NSString.class]) bytes += [arg lengthOfBytesUsingEncoding:NSUTF8StringEncoding] + 1; }
  NSMutableArray *environment = [NSMutableArray new];
  for (id key in env) {
    id value = env[key];
    if (![key isKindOfClass:NSString.class] || ![value isKindOfClass:NSString.class]) { valid = NO; continue; }
    valid = valid && validString(key, 4096) && [key length] > 0 && [key rangeOfString:@"="].location == NSNotFound && validString(value, 131072);
    if ([key isKindOfClass:NSString.class] && [value isKindOfClass:NSString.class]) { NSString *entry = [NSString stringWithFormat:@"%@=%@",key,value]; [environment addObject:entry]; bytes += [entry lengthOfBytesUsingEncoding:NSUTF8StringEncoding] + 1; }
  }
  NSData *input = [inputBase64 isKindOfClass:NSString.class] ? [[NSData alloc] initWithBase64EncodedString:inputBase64 options:0] : nil;
  if (!valid || bytes > 1024 * 1024 || !input || input.length > CaptureLimit) { reject(@"invalid_argument", @"Invalid command arguments, environment, input or timeout", nil); return; }
  [self.coordinator.lock lock];
  if(self.invalidated){[self.coordinator.lock unlock];reject(@"spawn_error",@"Native bridge generation is invalidated",nil);return;}
  if (!self.coordinator.journalUsable) { [self.coordinator.lock unlock]; reject(@"journal_failed", @"Command journal is unreadable; execution is disabled to prevent replay", nil); return; }
  if ([self.coordinator.closing containsObject:workspace]) { [self.coordinator.lock unlock]; reject(@"workspace_closing", @"Workspace cleanup is in progress", nil); return; }
  if (self.coordinator.journal[identifier]) { NSDictionary *status = self.coordinator.journal[identifier]; [self.coordinator.lock unlock]; reject(@"duplicate_command", [NSString stringWithFormat:@"Command ID already recorded (%@); use commandStatus",status[@"status"]], nil); return; }
  NSUInteger retainedInput = 0;
  for (MooseISHJob *active in self.coordinator.jobs.allValues) retainedInput += active.input.length;
  if (self.coordinator.jobs.count >= ActiveJobLimit || retainedInput + input.length > RetainedInputLimit || self.coordinator.journal.count >= JournalRecordLimit) {
    [self.coordinator.lock unlock]; reject(@"spawn_error", @"Embedded execution capacity is exhausted; no command was started or recorded", nil); return;
  }
  NSError *error = nil;
  if (![self prepareRoot:workspace error:&error]) { [self.coordinator.lock unlock]; reject(@"prepare_failed",error.localizedDescription,error); return; }
  int inPipe[2] = {-1,-1}, outPipe[2] = {-1,-1}, errPipe[2] = {-1,-1};
  if (pipe(inPipe) || pipe(outPipe) || pipe(errPipe)) {
    for (int i=0;i<2;i++) { if(inPipe[i]>=0)close(inPipe[i]); if(outPipe[i]>=0)close(outPipe[i]); if(errPipe[i]>=0)close(errPipe[i]); }
    [self.coordinator.lock unlock]; reject(@"pipe_failed",@"Cannot allocate command pipes",nil); return;
  }
  const char **args = calloc(argv.count, sizeof(char *));
  const char **vars = calloc(MAX(environment.count,1), sizeof(char *));
  if (!args || !vars) { free(args);free(vars);for(int i=0;i<2;i++){close(inPipe[i]);close(outPipe[i]);close(errPipe[i]);}[self.coordinator.lock unlock];reject(@"allocation_failed",@"Cannot allocate command",nil);return; }
  for (NSUInteger i=0;i<argv.count;i++) args[i]=[argv[i] UTF8String];
  for (NSUInteger i=0;i<environment.count;i++) vars[i]=[environment[i] UTF8String];
  moose_ish_options options = {.root = [[[self rootFor:workspace] stringByAppendingPathComponent:@"data"] fileSystemRepresentation], .cwd=cwd.UTF8String, .argc=(int)argv.count, .argv=args, .envc=(int)environment.count, .env=vars, .stdin_fd=inPipe[0], .stdout_fd=outPipe[1], .stderr_fd=errPipe[1], .timeout_ms=timeout.unsignedIntValue};
  moose_ish_command *command = moose_ish_command_create(&options);
  free(args); free(vars); close(inPipe[0]); close(outPipe[1]); close(errPipe[1]);
  if (!command) { close(inPipe[1]);close(outPipe[0]);close(errPipe[0]);[self.coordinator.lock unlock]; reject(@"spawn_error",@"Embedded core rejected command",nil);return; }
  MooseISHJob *job = [MooseISHJob new]; job.identifier=identifier;job.workspace=workspace;job.generation=self.generation;job.command=command;job.input=input;job.lock=[NSLock new];job.inputFD=inPipe[1];job.outputFD=outPipe[0];job.errorFD=errPipe[0];job.resolve=resolve;job.reject=reject;
  self.coordinator.journal[identifier]=@{@"workspace":workspace,@"status":@"running"};
  if (![self saveJournal]) { [self.coordinator.journal removeObjectForKey:identifier]; moose_ish_command_destroy(command);close(inPipe[1]);close(outPipe[0]);close(errPipe[0]);[self.coordinator.lock unlock];reject(@"journal_failed",@"Cannot persist command ID; command was not started",nil);return; }
  self.coordinator.jobs[identifier]=job;
  if ([self.coordinator.cancelledIDs containsObject:identifier]) { moose_ish_command_cancel(command); [self.coordinator.cancelledIDs removeObject:identifier]; }
  [self.coordinator.lock unlock];
  MooseISHRunner *runner = [MooseISHRunner new];runner.bridge=self;runner.job=job;
  pthread_t thread;
  void *context = (__bridge_retained void *)runner;
  if (pthread_create(&thread,NULL,runBridge,context)==0) pthread_detach(thread);
  else { CFBridgingRelease(context); [self finishFailedJob:job]; }
}
- (void)finishFailedJob:(MooseISHJob *)job {
  [self.coordinator.lock lock]; moose_ish_command_destroy(job.command); job.command=NULL; [self.coordinator.jobs removeObjectForKey:job.identifier]; self.coordinator.journal[job.identifier]=@{@"workspace":job.workspace,@"status":@"interrupted"}; [self saveJournal]; [self.coordinator.lock unlock];
  close(job.inputFD);close(job.outputFD);close(job.errorFD); job.reject(@"thread_failed",@"Cannot start native worker",nil);
}
- (void)runJob:(MooseISHJob *)job {
  // Guest tasks may pthread_exit. Only this dedicated thread enters the core.
  pthread_t core;
  void *context = (__bridge_retained void *)job;
  if (pthread_create(&core,NULL,runCore,context)) { CFBridgingRelease(context);[self finishFailedJob:job];return; }
  int noSigPipe=1; fcntl(job.inputFD,F_SETNOSIGPIPE,noSigPipe);
  fcntl(job.inputFD,F_SETFL,O_NONBLOCK);fcntl(job.outputFD,F_SETFL,O_NONBLOCK);fcntl(job.errorFD,F_SETFL,O_NONBLOCK);
  NSUInteger offset=0, omitted=0; NSMutableData *out=[NSMutableData new], *err=[NSMutableData new];
  BOOL outOpen=YES, errOpen=YES, inputOpen=YES;
  for (;;) {
    [job.lock lock];BOOL finished=job.finished;[job.lock unlock];
    if (inputOpen && (offset==job.input.length || finished)) {close(job.inputFD);inputOpen=NO;}
    struct pollfd descriptors[3]={{outOpen?job.outputFD:-1,POLLIN,0},{errOpen?job.errorFD:-1,POLLIN,0},{inputOpen?job.inputFD:-1,POLLOUT,0}};
    poll(descriptors,3,20);
    if (inputOpen && (descriptors[2].revents & (POLLOUT|POLLERR|POLLHUP))) {
      ssize_t n=write(job.inputFD,(const char *)job.input.bytes+offset,MIN((NSUInteger)65536,job.input.length-offset));
      if(n>0)offset+=n;else if(n<0 && errno!=EAGAIN && errno!=EINTR){close(job.inputFD);inputOpen=NO;}
    }
    for(int index=0;index<2;index++) {
      BOOL open=index==0?outOpen:errOpen;
      if(!open)continue;
      char buffer[16384];ssize_t n=read(index==0?job.outputFD:job.errorFD,buffer,sizeof(buffer));
      if(n>0){
        NSUInteger retained=MIN((NSUInteger)n,CaptureLimit-out.length-err.length);
        if(retained){NSData *chunk=[NSData dataWithBytes:buffer length:retained];[(index==0?out:err) appendData:chunk];NSDictionary *event=@{@"commandId":job.identifier,@"stream":index==0?@"stdout":@"stderr",@"data":[chunk base64EncodedStringWithOptions:0]};dispatch_async(dispatch_get_main_queue(),^{if(!self.invalidated)[self sendEventWithName:@"MooseISHOutput" body:event];});}
        omitted+=(NSUInteger)n-retained;
        if(omitted) { [self.coordinator.lock lock]; if(job.command)moose_ish_command_cancel(job.command);[self.coordinator.lock unlock]; }
      } else if(n==0 || (n<0 && errno!=EINTR && errno!=EAGAIN)) {close(index==0?job.outputFD:job.errorFD);if(index==0)outOpen=NO;else errOpen=NO;}
    }
    if(finished && !outOpen && !errOpen)break;
  }
  pthread_join(core,NULL);
  moose_ish_result result=job.result;
  job.input = nil; // Release retained stdin before admitting more commands.
  [self.coordinator.lock lock];moose_ish_command_destroy(job.command);job.command=NULL;self.coordinator.journal[job.identifier]=@{@"workspace":job.workspace,@"status":result.error?@"failed":@"completed",@"exitCode":@(result.exit_code)};BOOL saved=[self saveJournal];[self.coordinator.lock unlock];
  // Events and settlement share one queue, so JS sees all chunks before resolve.
  dispatch_async(dispatch_get_main_queue(), ^{
    [self.coordinator.lock lock]; [self.coordinator.jobs removeObjectForKey:job.identifier]; [self.coordinator.lock unlock];
    if(!saved)job.reject(@"journal_failed",@"Command ended but final status could not be saved",nil);
    else if(result.error)job.reject(@"spawn_error",[NSString stringWithFormat:@"Embedded command setup failed (%d)",result.error],nil);
    else job.resolve(@{@"exitCode":@(result.exit_code),@"stdout":[out base64EncodedStringWithOptions:0],@"stderr":[err base64EncodedStringWithOptions:0],@"omittedBytes":@(omitted),@"cancelled":@(result.cancelled),@"timedOut":@(result.timed_out)});
  });
}
RCT_REMAP_METHOD(cancel, cancel:(NSString *)identifier resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  if(!validID(identifier)){reject(@"invalid_argument",@"Invalid command ID",nil);return;}
  [self.coordinator.lock lock];if(self.invalidated){[self.coordinator.lock unlock];reject(@"spawn_error",@"Native bridge generation is invalidated",nil);return;}MooseISHJob *job=self.coordinator.jobs[identifier];if(job.command)moose_ish_command_cancel(job.command);else if(!self.coordinator.journal[identifier]){if(self.coordinator.cancelledIDs.count>=JournalRecordLimit && ![self.coordinator.cancelledIDs containsObject:identifier]){[self.coordinator.lock unlock];reject(@"spawn_error",@"Pending cancellation capacity is exhausted",nil);return;}[self.coordinator.cancelledIDs addObject:identifier];}[self.coordinator.lock unlock];resolve(nil);
}
RCT_REMAP_METHOD(cleanup, cleanup:(NSString *)workspace resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  if(!validID(workspace)){reject(@"invalid_argument",@"Invalid workspace ID",nil);return;}
  [self.coordinator.lock lock];if(self.invalidated){[self.coordinator.lock unlock];reject(@"spawn_error",@"Native bridge generation is invalidated",nil);return;}[self.coordinator.closing addObject:workspace];for(MooseISHJob *job in self.coordinator.jobs.allValues)if([job.workspace isEqual:workspace] && job.command)moose_ish_command_cancel(job.command);[self.coordinator.lock unlock];
  // Wait without occupying React Native's method queue, preserving prompt cancel.
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY,0),^{for(;;){[self.coordinator.lock lock];BOOL active=NO;for(MooseISHJob *job in self.coordinator.jobs.allValues)if([job.workspace isEqual:workspace]){active=YES;break;}[self.coordinator.lock unlock];if(!active)break;usleep(10000);}[self.coordinator.lock lock];[self.coordinator.closing removeObject:workspace];[self.coordinator.lock unlock];resolve(nil);});
}
@end
