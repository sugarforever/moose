package dev.verysmallwoods.background

import android.app.Activity
import androidx.core.app.NotificationManagerCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MooseBackgroundModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MooseBackground")
    Events("stop")
    OnCreate {
      MooseExecutionService.emitStop = { sendEvent("stop") }
    }
    OnDestroy {
      MooseExecutionService.instance?.runtimeDestroyed()
      MooseExecutionService.emitStop = null
    }
    AsyncFunction("start") { token: String, promise: Promise ->
      val context = requireNotNull(appContext.reactContext as? com.facebook.react.bridge.ReactContext)
      val activity: Activity = requireNotNull(appContext.currentActivity) { "Return to Moose to start a task" }
      require(!activity.isFinishing && !activity.isDestroyed && context.lifecycleState == com.facebook.react.common.LifecycleState.RESUMED) { "Return to Moose to start a task" }
      require(NotificationManagerCompat.from(context).areNotificationsEnabled()) { "Allow notifications to run background tasks" }
      require(!MooseExecutionService.pendingStop(context)) { "Background cancellation pending" }
      MooseExecutionService.request(context, token, promise)
    }.runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)
    Function("ready") { token: String -> MooseExecutionService.instance?.ready(token) }
    AsyncFunction("stop") { token: String -> MooseExecutionService.releaseRequest(token) }
      .runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)
    Function("waiting") { id: Double, value: Boolean -> MooseExecutionService.instance?.waiting(id.toLong(), value) }
    Function("progress") { items: List<Map<String, Any>> -> MooseExecutionService.instance?.progress(items) }
    AsyncFunction("result") { id: Double, failed: Boolean, detail: String ->
      MooseExecutionService.result(requireNotNull(appContext.reactContext as? com.facebook.react.bridge.ReactContext), id.toLong(), failed, detail)
    }.runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)
    Function("pendingStop") { MooseExecutionService.pendingStop(requireNotNull(appContext.reactContext)) }
    Function("stopDetail") { MooseExecutionService.stopDetail(requireNotNull(appContext.reactContext)) }
    Function("acknowledgeStop") {
      val context = requireNotNull(appContext.reactContext)
      MooseExecutionService.clearStop(context)
      MooseExecutionService.instance?.acknowledgeStop()
    }
  }
}
