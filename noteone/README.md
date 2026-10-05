# 书签站 noteone / EdgeOne 版本

这是面向腾讯云 noteone / EdgeOne 的独立小版本，适合中国大陆访问。保留原书签功能，并增加备注书签的橙色提示标识，鼠标移到标识上即可快速查看备注。

本版本改用 EdgeOne 边缘函数与 Blob 存储，访问入口为 `book.090803.xyz`。原 Cloudflare 版本继续保留，两个版本的数据和用途可以分开维护。

Blob 名称 bookmarks，使用 strong 强一致读取。
前端通过边缘函数提供，保留访问锁；静态发布目录仅含占位页。

构建：node bump.cjs，然后 node build.cjs。
部署令牌和数据备份保存在项目外。
