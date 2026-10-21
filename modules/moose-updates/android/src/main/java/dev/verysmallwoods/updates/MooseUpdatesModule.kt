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
  private val context get() = requireNotNull(appContext.reactContext) { "Application context is unavailable" }

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
    require(sha256.matches(Regex("[a-f0-9]{64}"))) { "Invalid package digest" }
    val file = apk()
    require(file.isFile && file.length().toDouble() == size) { "Package size verification failed. Download it again." }
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
    require(actual == sha256) { "Package SHA-256 verification failed. Download it again." }
    val pm = context.packageManager
    val installed = pm.getPackageInfo(context.packageName, flags())
    val incoming = requireNotNull(pm.getPackageArchiveInfo(file.absolutePath, flags())) { "Unable to read the package" }
    require(incoming.packageName == context.packageName) { "The package does not belong to Moose" }
    require(code(incoming).toDouble() == versionCode && code(incoming) > code(installed)) { "Invalid package version" }
    require(signatures(installed).isNotEmpty() && signatures(incoming) == signatures(installed)) {
      "The package signature differs from the installed app. It cannot be installed as an update."
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
      require(Build.VERSION.SDK_INT >= 26) { "This system does not require separate permission" }
      require(installGeneration.get().toDouble() == token) { "Installation cancelled" }
      context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
        Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    AsyncFunction("verify") { sha256: String, size: Double, versionCode: Double ->
      verify(sha256, size, versionCode)
      Unit
    }
    AsyncFunction("install") { sha256: String, size: Double, versionCode: Double, token: Double ->
      val file = verify(sha256, size, versionCode)
      require(installGeneration.get().toDouble() == token) { "Installation cancelled" }
      val uri = FileProvider.getUriForFile(context, "${context.packageName}.moose.updates", file)
      val intent = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, "application/vnd.android.package-archive")
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
      context.startActivity(intent)
    }
  }
}
