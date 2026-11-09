using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class Launcher {
    private const string Version = "0.3.0";
    private static string origin;
    private static string dataRoot;
    private static bool verify;

    [STAThread]
    private static int Main(string[] args) {
        verify = Array.IndexOf(args, "--verify") >= 0;
        try {
            string home = AppDomain.CurrentDomain.BaseDirectory;
            string exportHome = Path.Combine(home, "粉丝UID导出");
            if (!File.Exists(Path.Combine(home, "runtime", "node.exe")))
                home = Path.Combine(home, "dist", "微博粉丝助手_" + Version);
            string node = Path.Combine(home, "runtime", "node.exe");
            string app = Path.Combine(home, "app", "watch-app.mjs");
            if (!File.Exists(node) || !File.Exists(app))
                throw new Exception("没有找到程序组件。请保留整个软件文件夹，或使用项目目录中的新版启动文件。");
            dataRoot = Environment.GetEnvironmentVariable("WEIBO_MONITOR_DATA_DIR");
            if (String.IsNullOrWhiteSpace(dataRoot)) dataRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WeiboFollowerProbe");
            dataRoot = Path.GetFullPath(dataRoot);
            int port;
            string portText = Environment.GetEnvironmentVariable("WEIBO_MONITOR_PORT");
            if (String.IsNullOrEmpty(portText)) portText = "8766";
            if (!Int32.TryParse(portText, out port) || port < 1 || port > 65535) throw new Exception("本地服务端口无效。");
            origin = "http://127.0.0.1:" + port + "/";
            using (Mutex gate = new Mutex(false, @"Local\WeiboFollowerAssistantLaunch_" + port)) {
                bool acquired = false;
                try {
                    try { acquired = gate.WaitOne(30000); } catch (AbandonedMutexException) { acquired = true; }
                    if (!acquired) throw new Exception("程序正在启动，请稍后再试。");
                    Dictionary<string, object> state = Probe();
                    if (state == null) {
                        ProcessStartInfo info = new ProcessStartInfo(node, "--disable-warning=ExperimentalWarning " + Quote(app));
                        info.UseShellExecute = false;
                        info.CreateNoWindow = true;
                        info.WorkingDirectory = Path.Combine(home, "app");
                        info.EnvironmentVariables["WEIBO_MONITOR_DATA_DIR"] = dataRoot;
                        info.EnvironmentVariables["WEIBO_MONITOR_PORT"] = portText;
                        info.EnvironmentVariables["WEIBO_MONITOR_EXPORT_DIR"] = exportHome;
                        using (Process child = Process.Start(info)) {
                            DateTime deadline = DateTime.UtcNow.AddSeconds(40);
                            do {
                                Thread.Sleep(200);
                                state = Probe();
                                if (state != null) break;
                                if (child.HasExited) throw new Exception("后台启动失败。请运行软件文件夹内的“启动调试.cmd”查看提示。");
                            } while (DateTime.UtcNow < deadline);
                        }
                        if (state == null) throw new Exception("后台启动超时，请稍后重试。");
                    }
                    Validate(state);
                    if (!verify) OpenWindow();
                    return 0;
                } finally { if (acquired) gate.ReleaseMutex(); }
            }
        } catch (Exception e) {
            try { Directory.CreateDirectory(dataRoot ?? AppDomain.CurrentDomain.BaseDirectory); File.AppendAllText(Path.Combine(dataRoot ?? AppDomain.CurrentDomain.BaseDirectory, "launcher-error.log"), DateTime.Now.ToString("s") + " " + e.Message + Environment.NewLine); } catch { }
            if (!verify) MessageBox.Show(e.Message, "微博粉丝助手 — 启动提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 1;
        }
    }
    private static string Quote(string value) { return "\"" + value + "\""; }
    private static Dictionary<string, object> Probe() {
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(origin + "api/state");
        request.Proxy = null;
        request.Timeout = 1500;
        request.ReadWriteTimeout = 1500;
        try {
            using (WebResponse response = request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream()))
                return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
        } catch (WebException e) {
            if (e.Status == WebExceptionStatus.ConnectFailure || e.Status == WebExceptionStatus.Timeout) return null;
            HttpWebResponse response = e.Response as HttpWebResponse;
            if (response != null && response.StatusCode == HttpStatusCode.ServiceUnavailable) { response.Close(); return null; }
            if (response != null) response.Close();
            throw new Exception("当前后台状态异常。请先在旧界面中退出程序，再启动新版；已有记录不会被删除。");
        } catch (ArgumentException) { throw new Exception("本地端口已被其他程序占用，请先关闭占用该端口的程序。"); }
    }
    private static void Validate(Dictionary<string, object> state) {
        object app, version, root, id;
        if (!state.TryGetValue("app", out app) || Convert.ToString(app) != "weibo-follower-monitor") throw new Exception("本地端口被其他程序占用。");
        if (!state.TryGetValue("version", out version) || Convert.ToString(version) != Version) throw new Exception("旧版本后台仍在运行。请在旧界面右上角点击“退出程序”，再双击这个新版文件。");
        if (!state.TryGetValue("dataRoot", out root) || !String.Equals(Path.GetFullPath(Convert.ToString(root)).TrimEnd('\\'), dataRoot.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) throw new Exception("已有后台使用了其他数据目录，请退出旧后台后重试，避免账号记录混用。");
        if (!state.TryGetValue("databaseId", out id) || String.IsNullOrEmpty(Convert.ToString(id))) throw new Exception("无法确认数据库身份，请退出程序后重试。");
    }
    private static void OpenWindow() {
        string edge = null;
        foreach (string baseDir in new string[] {Environment.GetEnvironmentVariable("ProgramFiles(x86)"), Environment.GetEnvironmentVariable("ProgramFiles"), Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)}) {
            if (String.IsNullOrEmpty(baseDir)) continue;
            string candidate = Path.Combine(baseDir, "Microsoft", "Edge", "Application", "msedge.exe");
            if (File.Exists(candidate)) { edge = candidate; break; }
        }
        if (edge == null) throw new Exception("请先安装 Microsoft Edge 浏览器。");
        ProcessStartInfo info = new ProcessStartInfo(edge, "--app=" + origin + " --window-size=1280,820");
        info.UseShellExecute = false;
        Process.Start(info);
    }
}
