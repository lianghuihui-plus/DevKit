package mavt.android.ime;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Base64;

public class MavtInputReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context context, Intent intent) {
    String text64 = intent.getStringExtra("text64");
    String mode = intent.getStringExtra("mode");
    if (mode == null || mode.length() == 0) {
      mode = "replace";
    }
    if (!mode.equals("replace") && !mode.equals("append")) {
      setResultCode(Activity.RESULT_CANCELED);
      setResultData("Unsupported mode: " + mode);
      return;
    }
    if (text64 == null || text64.length() == 0) {
      setResultCode(Activity.RESULT_CANCELED);
      setResultData("Missing text64");
      return;
    }
    try {
      String text = new String(Base64.decode(text64, Base64.DEFAULT), "UTF-8");
      if (MavtInputMethodService.inputText(text, mode)) {
        setResultCode(Activity.RESULT_OK);
        setResultData("OK");
      } else {
        setResultCode(Activity.RESULT_CANCELED);
        setResultData("No active MAVT input connection");
      }
    } catch (Exception error) {
      setResultCode(Activity.RESULT_CANCELED);
      setResultData(error.toString());
    }
  }
}
