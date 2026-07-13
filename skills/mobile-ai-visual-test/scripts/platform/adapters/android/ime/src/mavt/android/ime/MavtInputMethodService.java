package mavt.android.ime;

import android.inputmethodservice.InputMethodService;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;

public class MavtInputMethodService extends InputMethodService {
  private static MavtInputMethodService current;

  @Override
  public void onCreate() {
    super.onCreate();
    current = this;
  }

  @Override
  public void onDestroy() {
    if (current == this) {
      current = null;
    }
    super.onDestroy();
  }

  static boolean replaceText(String text) {
    MavtInputMethodService service = current;
    if (service == null) {
      return false;
    }
    InputConnection input = service.getCurrentInputConnection();
    if (input == null) {
      return false;
    }
    EditorInfo info = service.getCurrentInputEditorInfo();
    if (info == null || info.inputType == 0) {
      return false;
    }
    input.beginBatchEdit();
    input.performContextMenuAction(android.R.id.selectAll);
    input.deleteSurroundingText(100000, 100000);
    boolean ok = input.commitText(text, 1);
    input.endBatchEdit();
    return ok;
  }
}
