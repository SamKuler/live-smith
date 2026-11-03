#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#include <stdio.h>
#include <unistd.h>
#include <sys/stat.h>

static void sendMessage(NSDictionary *message) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:message options:0 error:nil];
  if (data) { fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); fflush(stdout); }
}
static NSDictionary *readMessage(void) {
  char *line = NULL; size_t capacity = 0; ssize_t count = getline(&line, &capacity, stdin);
  if (count < 1 || count > 65536) { free(line); return nil; }
  NSData *data = [NSData dataWithBytes:line length:count]; free(line);
  id result = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  return [result isKindOfClass:NSDictionary.class] ? result : nil;
}

@interface ChatWindow : NSWindow
@property(strong) NSEvent *dragEvent;
@property(assign) NSUInteger mouseSequence;
@property(assign) BOOL mouseDown;
@end
@implementation ChatWindow
- (void)sendEvent:(NSEvent *)event {
  if (event.type == NSEventTypeLeftMouseDown) { self.mouseSequence++; self.mouseDown = YES; self.dragEvent = nil; }
  if (event.type == NSEventTypeLeftMouseDragged && self.mouseDown) self.dragEvent = event;
  if (event.type == NSEventTypeLeftMouseUp) { self.mouseDown = NO; self.dragEvent = nil; }
  [super sendEvent:event];
}
@end

@interface NativeChat : NSObject <NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, NSDraggingSource>
@property(strong) NSURL *chatURL;
@property(strong) ChatWindow *window;
@property(strong) WKWebView *webView;
@property(strong) NSMutableDictionary<NSString *, NSURL *> *files;
@property(strong) NSMutableDictionary<NSString *, NSDictionary *> *claims;
@property(strong) NSString *activeDrag;
@property(strong) NSTimer *parentWatch;
@property(assign) pid_t parent;
@property(assign) BOOL ready;
@property(assign) BOOL allowClose;
@end

@implementation NativeChat
- (BOOL)allowedDocument:(NSURL *)url {
  if (![url.scheme isEqualToString:self.chatURL.scheme] || ![url.host isEqualToString:self.chatURL.host] ||
      ![url.port isEqual:self.chatURL.port] || ![url.path isEqualToString:@"/chat"] || url.user || url.password) return NO;
  NSString *expected, *actual;
  for (NSURLQueryItem *item in [NSURLComponents componentsWithURL:self.chatURL resolvingAgainstBaseURL:NO].queryItems)
    if ([item.name isEqualToString:@"token"]) expected = item.value;
  for (NSURLQueryItem *item in [NSURLComponents componentsWithURL:url resolvingAgainstBaseURL:NO].queryItems)
    if ([item.name isEqualToString:@"token"]) actual = item.value;
  return expected.length && [expected isEqualToString:actual];
}
- (void)reply:(NSDictionary *)message {
  NSData *data = [NSJSONSerialization dataWithJSONObject:message options:0 error:nil];
  NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  if (json) [self.webView evaluateJavaScript:[NSString stringWithFormat:@"window.LiveSmithNativeDrag?.receive(%@)", json] completionHandler:nil];
}
- (void)terminate {
  self.allowClose = YES; [NSApp terminate:nil];
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  self.files = [NSMutableDictionary new]; self.claims = [NSMutableDictionary new];
  self.window = [[ChatWindow alloc] initWithContentRect:NSMakeRect(0, 0, 1040, 720)
    styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
    backing:NSBackingStoreBuffered defer:NO];
  self.window.title = @"Live Smith"; self.window.minSize = NSMakeSize(480, 420); self.window.delegate = self;
  WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
  configuration.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
  [configuration.userContentController addScriptMessageHandler:self name:@"live"];
  [configuration.userContentController addScriptMessageHandler:self name:@"nativeDrag"];
  self.webView = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds configuration:configuration];
  self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  self.webView.navigationDelegate = self; self.webView.UIDelegate = self;
  [self.window.contentView addSubview:self.webView];
  NSMenu *menu = [NSMenu new]; NSMenuItem *appItem = [NSMenuItem new]; NSMenu *appMenu = [NSMenu new];
  [appMenu addItemWithTitle:@"Quit Live Smith" action:@selector(terminate:) keyEquivalent:@"q"];
  appItem.submenu = appMenu; [menu addItem:appItem];
  NSMenuItem *fileItem = [NSMenuItem new]; NSMenu *fileMenu = [[NSMenu alloc] initWithTitle:@"File"];
  [fileMenu addItemWithTitle:@"Close Window" action:@selector(performClose:) keyEquivalent:@"w"];
  fileItem.submenu = fileMenu; [menu addItem:fileItem];
  NSMenuItem *editItem = [NSMenuItem new]; NSMenu *edit = [[NSMenu alloc] initWithTitle:@"Edit"];
  [edit addItemWithTitle:@"Undo" action:@selector(undo:) keyEquivalent:@"z"];
  [edit addItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x"];
  [edit addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
  [edit addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
  [edit addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];
  editItem.submenu = edit; [menu addItem:editItem]; NSApp.mainMenu = menu;
  self.parent = getppid();
  self.parentWatch = [NSTimer scheduledTimerWithTimeInterval:1 repeats:YES block:^(NSTimer *timer) {
    if (getppid() != self.parent) [self terminate];
  }];
  [self.window center]; [self.window makeKeyAndOrderFront:nil]; [NSApp activateIgnoringOtherApps:YES];
  [self.webView loadRequest:[NSURLRequest requestWithURL:self.chatURL]];
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    for (;;) {
      NSDictionary *message = readMessage();
      if (!message) { dispatch_async(dispatch_get_main_queue(), ^{ [self terminate]; }); return; }
      dispatch_async(dispatch_get_main_queue(), ^{ [self receive:message]; });
    }
  });
}
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
  if (self.ready || ![self allowedDocument:webView.URL]) return;
  [webView evaluateJavaScript:@"typeof window.LiveSmithUI?.requestClose === 'function'" completionHandler:^(id value, NSError *error) {
    if (error || ![value isEqual:@YES]) { [self terminate]; return; }
    self.ready = YES; sendMessage(@{@"type":@"ready"});
  }];
}
- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
  if (!self.ready) [self terminate];
}
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView { [self terminate]; }
- (void)requestClose { [self.webView evaluateJavaScript:@"window.LiveSmithUI?.requestClose()" completionHandler:nil]; }
- (void)cancelStartup {
  if (!self.allowClose) sendMessage(@{@"type":@"cancelled"});
  self.allowClose = YES;
}
- (BOOL)windowShouldClose:(NSWindow *)sender {
  if (self.allowClose) return YES;
  if (!self.ready) { [self cancelStartup]; return YES; }
  [self requestClose]; return NO;
}
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
  if (self.allowClose) return NSTerminateNow;
  if (!self.ready) { [self cancelStartup]; return NSTerminateNow; }
  [self requestClose]; return NSTerminateCancel;
}
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender { return YES; }
- (void)openExternal:(WKNavigationAction *)action {
  NSURL *url = action.request.URL;
  if (action.navigationType == WKNavigationTypeLinkActivated && [@[@"https",@"http"] containsObject:url.scheme])
    [NSWorkspace.sharedWorkspace openURL:url];
}
- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
  if (action.targetFrame && !action.targetFrame.mainFrame) { decisionHandler(WKNavigationActionPolicyAllow); return; }
  if ([self allowedDocument:action.request.URL]) { decisionHandler(WKNavigationActionPolicyAllow); return; }
  [self openExternal:action]; decisionHandler(WKNavigationActionPolicyCancel);
}
- (WKWebView *)webView:(WKWebView *)webView createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration forNavigationAction:(WKNavigationAction *)action windowFeatures:(WKWindowFeatures *)windowFeatures {
  [self openExternal:action]; return nil;
}
- (void)webView:(WKWebView *)webView runOpenPanelWithParameters:(WKOpenPanelParameters *)parameters initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(NSArray<NSURL *> *))completionHandler {
  NSOpenPanel *panel = [NSOpenPanel openPanel]; panel.allowsMultipleSelection = parameters.allowsMultipleSelection;
  panel.canChooseDirectories = parameters.allowsDirectories; panel.canChooseFiles = YES;
  [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) { completionHandler(response == NSModalResponseOK ? panel.URLs : nil); }];
}
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
  if (!message.frameInfo.mainFrame || ![self allowedDocument:message.frameInfo.request.URL] || ![self allowedDocument:self.webView.URL] || ![message.body isKindOfClass:NSDictionary.class]) return;
  NSDictionary *body = message.body;
  if ([message.name isEqualToString:@"live"] && [body[@"method"] isEqual:@"close_and_send"]) { [self terminate]; return; }
  if (![message.name isEqualToString:@"nativeDrag"] || ![body[@"id"] isKindOfClass:NSString.class]) return;
  if ([body[@"type"] isEqual:@"prepare"] && [body[@"sessionId"] isKindOfClass:NSString.class] && [body[@"artifact"] isKindOfClass:NSDictionary.class]) {
    sendMessage(@{@"type":@"prepare", @"id":body[@"id"], @"sessionId":body[@"sessionId"], @"artifact":body[@"artifact"]});
  } else if ([body[@"type"] isEqual:@"start"] && [body[@"token"] isKindOfClass:NSString.class]) {
    if (!self.files[body[@"token"]] || !self.window.mouseDown || !self.window.dragEvent || !(NSEvent.pressedMouseButtons & 1)) {
      [self reply:@{@"type":@"ended", @"id":body[@"id"], @"accepted":@NO}]; return;
    }
    self.claims[body[@"id"]] = @{@"token":body[@"token"], @"sequence":@(self.window.mouseSequence)};
    sendMessage(@{@"type":@"claim", @"id":body[@"id"], @"token":body[@"token"]});
  }
}
- (void)receive:(NSDictionary *)message {
  NSString *type = message[@"type"], *identifier = message[@"id"];
  if (![identifier isKindOfClass:NSString.class]) return;
  if ([type isEqual:@"prepared"] && [message[@"filePath"] isKindOfClass:NSString.class] && [message[@"token"] isKindOfClass:NSString.class]) {
    self.files[message[@"token"]] = [NSURL fileURLWithPath:message[@"filePath"]];
    [self reply:@{@"type":@"prepared",@"id":identifier,@"token":message[@"token"]}];
  } else if ([type isEqual:@"prepare_failed"]) {
    [self reply:@{@"type":@"prepare_failed",@"id":identifier}];
  } else if ([type isEqual:@"claimed"] || [type isEqual:@"claim_failed"]) {
    NSDictionary *claim = self.claims[identifier]; [self.claims removeObjectForKey:identifier];
    NSURL *file = claim ? self.files[claim[@"token"]] : nil;
    if (![type isEqual:@"claimed"] || !claim || !file || !self.window.mouseDown || !self.window.dragEvent ||
        [claim[@"sequence"] unsignedIntegerValue] != self.window.mouseSequence || !(NSEvent.pressedMouseButtons & 1)) {
      [self reply:@{@"type":@"ended",@"id":identifier,@"accepted":@NO}]; return;
    }
    struct stat metadata;
    if (lstat(file.fileSystemRepresentation, &metadata) || !S_ISREG(metadata.st_mode)) {
      [self reply:@{@"type":@"ended",@"id":identifier,@"accepted":@NO}]; return;
    }
    NSDraggingItem *item = [[NSDraggingItem alloc] initWithPasteboardWriter:file];
    NSPoint point = [self.webView convertPoint:self.window.dragEvent.locationInWindow fromView:nil];
    [item setDraggingFrame:NSMakeRect(point.x - 24, point.y - 24, 48, 48) contents:[NSWorkspace.sharedWorkspace iconForFile:file.path]];
    self.activeDrag = identifier;
    [self.webView beginDraggingSessionWithItems:@[item] event:self.window.dragEvent source:self];
  }
}
- (NSDragOperation)draggingSession:(NSDraggingSession *)session sourceOperationMaskForDraggingContext:(NSDraggingContext)context { return NSDragOperationCopy; }
- (void)draggingSession:(NSDraggingSession *)session endedAtPoint:(NSPoint)point operation:(NSDragOperation)operation {
  self.window.mouseDown = NO; self.window.dragEvent = nil;
  if (self.activeDrag) [self reply:@{@"type":@"ended",@"id":self.activeDrag,@"accepted":@(operation != NSDragOperationNone)}];
  self.activeDrag = nil;
}
@end

int main(void) {
  @autoreleasepool {
    NSDictionary *request = readMessage();
    if (![request[@"protocol"] isEqual:@1] || ![request[@"url"] isKindOfClass:NSString.class]) return 1;
    NSURL *url = [NSURL URLWithString:request[@"url"]];
    if (![url.scheme isEqual:@"http"] || ![@[@"127.0.0.1",@"localhost"] containsObject:url.host] || !url.port || ![url.path isEqual:@"/chat"] || url.user || url.password) return 1;
    NSApplication *app = NSApplication.sharedApplication; [app setActivationPolicy:NSApplicationActivationPolicyRegular];
    NativeChat *delegate = [NativeChat new]; delegate.chatURL = url; app.delegate = delegate; [app run];
  }
  return 0;
}
