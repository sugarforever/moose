package dev.verysmallwoods.updates

import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicLong

class MooseUpdatesModule : Module() {
  private val installGeneration = AtomicLong(0)
  private val context get() = requireNotNull(appContext.reactContext) { "应用上下文不可用" }

  @Suppress("DEPRECATION")
  private fun code(info: PackageInfo): Long =
    if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()

  @Suppress("DEPRECATION")
  private fun signatures(info: PackageInfo): Set<String> {
    val signatures = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
    return signatures?.map { it.toCharsString() }?.toSet() ?: emptySet()
  }

  @Suppress("DEPRECATION")
  private fun flags(): Int = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES

  // Never accept a caller-supplied path: only the single APK in our private update cache.
  private fun apk() = File(context.cacheDir, "moose-updates/update.apk")

  @Suppress("DEPRECATION")
  private fun verify(sha256: String, size: Double, versionCode: Double): File {
    require(sha256.matches(Regex("[a-f0-9]{64}"))) { "安装包摘要无效" }
    val file = apk()
    require(file.isFile && file.length().toDouble() == size) { "安装包大小校验失败，请重新下载" }
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().buffered().use { input ->
      val bytes = ByteArray(64 * 1024)
      while (true) {
        val count = input.read(bytes)
        if (count < 0) break
        digest.update(bytes, 0, count)
      }
    }
    val actual = digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
    require(actual == sha256) { "安装包 SHA-256 校验失败，请重新下载" }
    val pm = context.packageManager
    val installed = pm.getPackageInfo(context.packageName, flags())
    val incoming = requireNotNull(pm.getPackageArchiveInfo(file.absolutePath, flags())) { "无法读取安装包" }
    require(incoming.packageName == context.packageName) { "安装包不属于 Moose" }
    require(code(incoming).toDouble() == versionCode && code(incoming) > code(installed)) { "安装包版本无效" }
    require(signatures(installed).isNotEmpty() && signatures(incoming) == signatures(installed)) {
      "安装包签名与当前应用不同，无法覆盖更新"
    }
    return file
  }

  override fun definition() = ModuleDefinition {
    Name("MooseUpdates")

    Constants {
      @Suppress("DEPRECATION")
      val info = context.packageManager.getPackageInfo(context.packageName, 0)
      mapOf("version" to (info.versionName ?: ""), "versionCode" to code(info).toDouble())
    }

    AsyncFunction("canInstall") {
      Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls()
    }
    Function("beginInstall") { installGeneration.incrementAndGet().toDouble() }
    Function("cancelInstall") { installGeneration.incrementAndGet(); Unit }
    AsyncFunction("openPermission") { token: Double ->
      require(Build.VERSION.SDK_INT >= 26) { "此系统无需单独授权" }
      require(installGeneration.get().toDouble() == token) { "已取消安装" }
      context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
        Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    AsyncFunction("verify") { sha256: String, size: Double, versionCode: Double ->
      verify(sha256, size, versionCode)
      Unit
    }
    AsyncFunction("install") { sha256: String, size: Double, versionCode: Double, token: Double ->
      val file = verify(sha256, size, versionCode)
      require(installGeneration.get().toDouble() == token) { "已取消安装" }
      val uri = FileProvider.getUriForFile(context, "${context.packageName}.moose.updates", file)
      val intent = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, "application/vnd.android.package-archive")
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
      context.startActivity(intent)
    }
  }
}
