#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <Network/Network.h>
#include <stdio.h>
#include <signal.h>
#include <sys/stat.h>
#include <unistd.h>
#include <limits.h>
#include <mach-o/dyld.h>

static NSString *capsuleAppPath;

static void removeOwnCapsule(void) {
  // Executable identity and the Darwin user temp directory are available even
  // before AppKit initializes its bundle/environment metadata.
  NSString *app = capsuleAppPath;
  NSString *stage = app.stringByDeletingLastPathComponent;
  char temp[PATH_MAX];
  size_t tempSize = confstr(_CS_DARWIN_USER_TEMP_DIR, temp, sizeof(temp));
  if (!app || !tempSize || tempSize > sizeof(temp)) return;
  NSString *temporary = [NSString stringWithUTF8String:temp].stringByResolvingSymlinksInPath;
  if (![app.lastPathComponent isEqualToString:@"SunoVerification.app"] ||
      ![stage.lastPathComponent hasPrefix:@"live-smith-verification-"] ||
      ![stage.stringByDeletingLastPathComponent.stringByResolvingSymlinksInPath isEqualToString:temporary]) return;
  struct stat metadata;
  if (lstat(stage.fileSystemRepresentation, &metadata) || !S_ISDIR(metadata.st_mode) ||
      metadata.st_uid != geteuid() || (metadata.st_mode & 0777) != 0700) return;
  NSSet *allowed = [NSSet setWithArray:@[@"SunoVerification.app", @"SunoVerification.app/Contents",
      @"SunoVerification.app/Contents/MacOS", @"SunoVerification.app/Contents/MacOS/SunoVerification",
      @"SunoVerification.app/Contents/Info.plist", @"SunoVerification.app/Contents/_CodeSignature",
      @"SunoVerification.app/Contents/_CodeSignature/CodeResources"]];
  NSDirectoryEnumerator *entries = [NSFileManager.defaultManager enumeratorAtPath:stage];
  for (NSString *entry in entries) {
    NSString *path = [stage stringByAppendingPathComponent:entry];
    if (![allowed containsObject:entry] || lstat(path.fileSystemRepresentation, &metadata) ||
        metadata.st_uid != geteuid() || (!S_ISDIR(metadata.st_mode) && !S_ISREG(metadata.st_mode))) return;
  }
  // This exact directory contains only this generated, credential-free capsule.
  [NSFileManager.defaultManager removeItemAtPath:stage error:nil];
}

// stdout is a private child pipe. Never print diagnostics, tokens or causes to
// stderr, files, the application UI, or the system log.
static BOOL finished = NO;
static void finish(NSDictionary *value) {
  if (finished) return;
  finished = YES;
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  removeOwnCapsule();
  if (data) { fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); fflush(stdout); }
  [NSApp terminate:nil];
}
static void failed(NSString *code) { finish(@{@"type": @"failed", @"code": code}); }
static BOOL official(NSURL *url) {
  return [url.scheme isEqualToString:@"https"] && [url.host isEqualToString:@"suno.com"] &&
      (!url.port || url.port.integerValue == 443) && !url.user && !url.password;
}

@interface Verifier : NSObject <NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler>
@property(strong) NSDictionary *request;
@property(strong) NSWindow *window;
@property(strong) WKWebView *webView;
@property(strong) NSTextField *loadingLabel;
@property(strong) NSTimer *pageDeadline;
@property(strong) NSTimer *lifetime;
@property(assign) pid_t parent;
@end

@implementation Verifier
- (BOOL)configureProxy:(WKWebsiteDataStore *)store {
  NSDictionary *proxy = self.request[@"networkProxy"];
  if (![proxy isKindOfClass:NSDictionary.class]) return NO;
  NSString *mode = proxy[@"mode"];
  if ([mode isEqualToString:@"system"]) return YES;
  if (![mode isEqualToString:@"manual"]) return NO;
  NSURL *url = [NSURL URLWithString:proxy[@"url"]];
  if (!url.host.length || url.user || url.password || url.query || url.fragment ||
      (url.path.length && ![url.path isEqualToString:@"/"])) return NO;
  NSString *scheme = url.scheme;
  if (![@[@"http", @"https", @"socks", @"socks5"] containsObject:scheme]) return NO;
  NSInteger port = url.port ? url.port.integerValue : [scheme isEqualToString:@"https"] ? 443 : [scheme isEqualToString:@"http"] ? 80 : 1080;
  if (port < 1 || port > 65535) return NO;
  nw_endpoint_t endpoint = nw_endpoint_create_host(url.host.UTF8String, [NSString stringWithFormat:@"%ld", (long)port].UTF8String);
  nw_proxy_config_t config = [scheme hasPrefix:@"socks"] ? nw_proxy_config_create_socksv5(endpoint)
      : nw_proxy_config_create_http_connect(endpoint, [scheme isEqualToString:@"https"] ? nw_tls_create_options() : nil);
  if (!config) return NO;
  // Only the app-owned loopback direct tunnel receives ephemeral credentials.
  NSString *username = proxy[@"username"], *password = proxy[@"password"];
  if (username || password) {
    if (![url.host isEqualToString:@"127.0.0.1"] || ![scheme isEqualToString:@"http"] ||
        ![username isEqualToString:@"live-smith"] || ![password isKindOfClass:NSString.class] || password.length != 64) return NO;
    nw_proxy_config_set_username_and_password(config, username.UTF8String, password.UTF8String);
  }
  nw_proxy_config_set_failover_allowed(config, false);
  store.proxyConfigurations = @[config];
  return YES;
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  if (@available(macOS 14.0, *)) {} else { failed(@"unsupported-platform"); return; }
  NSDate *started = NSDate.date;
  self.lifetime = [NSTimer scheduledTimerWithTimeInterval:1 repeats:YES block:^(NSTimer *timer) {
    if (getppid() != self.parent) { finish(@{@"type": @"cancelled"}); return; }
    if ([NSDate.date timeIntervalSinceDate:started] >= 600) failed(@"verification-timeout");
  }];
  [NSRunLoop.mainRunLoop addTimer:self.lifetime forMode:NSRunLoopCommonModes];
  WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
  configuration.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
  if (![self configureProxy:configuration.websiteDataStore]) { failed(@"network-unavailable"); return; }
  NSString *script = self.request[@"script"];
  [configuration.userContentController addScriptMessageHandler:self name:@"liveSmithVerification"];
  [configuration.userContentController addUserScript:[[WKUserScript alloc] initWithSource:script
      injectionTime:WKUserScriptInjectionTimeAtDocumentEnd forMainFrameOnly:YES]];
  self.webView = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 620, 520) configuration:configuration];
  self.webView.navigationDelegate = self;
  self.webView.hidden = YES;
  self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 620, 520)
      styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable
      backing:NSBackingStoreBuffered defer:NO];
  self.window.minSize = NSMakeSize(420, 360);
  self.window.title = [@"Live Smith · Suno · " stringByAppendingString:self.request[@"connectionName"]];
  self.window.releasedWhenClosed = NO;
  self.window.delegate = self;
  self.window.contentView.wantsLayer = YES;
  self.window.contentView.layer.backgroundColor = [NSColor colorWithCalibratedWhite:41.0 / 255.0 alpha:1].CGColor;
  self.loadingLabel = [NSTextField labelWithString:@"Live Smith · Suno"];
  self.loadingLabel.textColor = NSColor.lightGrayColor;
  self.loadingLabel.frame = NSMakeRect(24, 460, 400, 28);
  self.loadingLabel.autoresizingMask = NSViewMinYMargin;
  [self.window.contentView addSubview:self.loadingLabel];
  [self.window.contentView addSubview:self.webView];
  [self.window center];
  [self.window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  self.pageDeadline = [NSTimer scheduledTimerWithTimeInterval:60 repeats:NO block:^(NSTimer *timer) { failed(@"page-load-timeout"); }];
  NSString *rules = @"[{\"trigger\":{\"url-filter\":\"^https://studio-api-prod[.]suno[.]com/api/generate/\"},\"action\":{\"type\":\"block\"}},{\"trigger\":{\"url-filter\":\"^https://studio-api-prod[.]suno[.]com/api/download/authorize\"},\"action\":{\"type\":\"block\"}}]";
  [WKContentRuleListStore.defaultStore compileContentRuleListForIdentifier:@"LiveSmithNoPaidVerification"
      encodedContentRuleList:rules completionHandler:^(WKContentRuleList *list, NSError *error) {
    if (!list || error) { failed(@"setup-error"); return; }
    [configuration.userContentController addContentRuleList:list];
    [self.webView loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:@"https://suno.com/create"]]];
  }];
}
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender { return YES; }
- (void)windowWillClose:(NSNotification *)notification { finish(@{@"type": @"cancelled"}); }
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
  if (!finished) finish(@{@"type": @"cancelled"});
  return NSTerminateNow;
}
- (void)webView:(WKWebView *)view decidePolicyForNavigationAction:(WKNavigationAction *)action
    decisionHandler:(void (^)(WKNavigationActionPolicy))decision {
  if (!action.targetFrame || action.targetFrame.mainFrame) {
    if (!official(action.request.URL)) { decision(WKNavigationActionPolicyCancel); failed(@"unsupported-domain"); return; }
  }
  decision(WKNavigationActionPolicyAllow);
}
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation {
  if (!official(view.URL)) { failed(@"unsupported-domain"); return; }
  NSString *installation = [self.request[@"script"] stringByAppendingString:@";Boolean(document.getElementById('live-smith-verification'));"];
  [view evaluateJavaScript:installation completionHandler:^(id value, NSError *error) {
    if (error || ![value isKindOfClass:NSNumber.class] || ![value boolValue]) { failed(@"setup-error"); return; }
    [self.pageDeadline invalidate];
    self.loadingLabel.hidden = YES;
    self.webView.hidden = NO;
  }];
}
- (void)webView:(WKWebView *)view didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
  if (error.code != NSURLErrorCancelled) failed(@"page-load-error");
}
- (void)webView:(WKWebView *)view didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error { failed(@"page-load-error"); }
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
  WKSecurityOrigin *origin = message.frameInfo.securityOrigin;
  if (finished || !message.frameInfo.mainFrame || ![origin.protocol isEqualToString:@"https"] ||
      ![origin.host isEqualToString:@"suno.com"] || (origin.port != 0 && origin.port != 443) ||
      ![message.body isKindOfClass:NSDictionary.class]) return;
  NSDictionary *body = message.body;
  NSString *type = body[@"type"];
  if ([type isEqualToString:@"cancelled"] && body.count == 1) { finish(@{@"type": @"cancelled"}); return; }
  if ([type isEqualToString:@"failed"] && body.count == 2 &&
      [@[@"unsupported-domain", @"unsupported-environment"] containsObject:body[@"code"]]) {
    failed(body[@"code"]); return;
  }
  if (![type isEqualToString:@"verified"] || body.count != 3 ||
      ![body[@"captchaVersion"] isEqual:self.request[@"captchaVersion"]]) return;
  NSString *token = body[@"token"];
  if (![token isKindOfClass:NSString.class] || !token.length || token.length > 16384 ||
      [token rangeOfCharacterFromSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].location != NSNotFound ||
      [token rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location != NSNotFound) { failed(@"invalid-result"); return; }
  finish(@{@"type": @"verified", @"captchaVersion": self.request[@"captchaVersion"], @"token": token,
      @"issuedAtMs": @((long long)(NSDate.date.timeIntervalSince1970 * 1000))});
}
@end

int main(void) {
  @autoreleasepool {
    signal(SIGPIPE, SIG_IGN);
    char executable[PATH_MAX];
    uint32_t executableSize = sizeof(executable);
    if (_NSGetExecutablePath(executable, &executableSize) == 0) {
      NSString *path = [NSString stringWithUTF8String:executable].stringByStandardizingPath;
      capsuleAppPath = path.stringByDeletingLastPathComponent.stringByDeletingLastPathComponent.stringByDeletingLastPathComponent;
    }
    pid_t parent = getppid();
    if (parent <= 1) { finish(@{@"type": @"cancelled"}); return 0; }
    char input[262145];
    size_t count = fread(input, 1, sizeof(input), stdin);
    if (!count || count == sizeof(input)) { failed(@"invalid-request"); return 0; }
    id value = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:input length:count] options:0 error:nil];
    if (![value isKindOfClass:NSDictionary.class]) { failed(@"invalid-request"); return 0; }
    NSDictionary *request = value;
    if (request.count != 5 || ![request[@"protocol"] isEqual:@1] ||
        ![@[@1, @2] containsObject:request[@"captchaVersion"]] ||
        ![request[@"script"] isKindOfClass:NSString.class] || [request[@"script"] length] > 200000 ||
        ![request[@"connectionName"] isKindOfClass:NSString.class] || [request[@"connectionName"] length] > 100) {
      failed(@"invalid-request"); return 0;
    }
    NSApplication *application = NSApplication.sharedApplication;
    [application setActivationPolicy:NSApplicationActivationPolicyAccessory];
    Verifier *delegate = [Verifier new];
    delegate.parent = parent;
    delegate.request = request;
    application.delegate = delegate;
    [application run];
  }
  return 0;
}
