Pod::Spec.new do |s|
  s.name = 'MooseISH'
  s.version = '0.1.0'
  s.summary = 'Optional in-process iSH execution for Moose'
  s.homepage = 'https://github.com/sugarforever/moose'
  s.license = { :type => 'See bundled iSH licenses; redistribution requires whole-program review' }
  s.author = 'Moose contributors'
  s.source = { :git => 'https://github.com/sugarforever/moose.git' }
  s.platform = :ios, '15.1'
  s.source_files = 'ios/*.{h,m}'
  s.vendored_frameworks = 'vendor/MooseISHCore.xcframework'
  s.resource_bundles = { 'MooseISHResources' => ['vendor/root', 'vendor/licenses', 'vendor/source-manifest.json'] }
  s.libraries = 'sqlite3', 'pthread'
  s.dependency 'React-Core'
end
