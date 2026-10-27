/*
 * rea-fc SourceGen CLI: a headless driver for the pinned 6502bench analysis.
 *
 * The analysis, the CPU/opcode tables and the project format come from
 * third_party/6502bench by reference; this file only decides what to ask it and
 * how to print the answer. It exists because SourceGen's own executable only
 * opens an existing .dis65 project in a WPF window, so an agent has no way to
 * build a project, read a cross-reference, or export one.
 *
 * Commands (all emit JSON on stdout, diagnostics on stderr):
 *   info    --data <file> [--base 0x8000] [--cpu 2a03]
 *   build   --data <file> [--base 0x8000] [--entry 0x8000] [--save-project out.dis65]
 *   stats   --data <file> [--base 0x8000]
 *   xref    --data <file> --address 0x0324
 *   line    --data <file> --address 0x8000 [--count 32]
 */
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

using Asm65;
using CommonUtil;
using SourceGen;

namespace SourceGenCli
{
    internal sealed class Options
    {
        public string Command = "help";
        public string DataPath;
        public int BaseAddress = 0x8000;
        public string CpuName = "2a03";
        public bool IncludeUndocumented = true;
        public bool TwoByteBrk;
        public readonly List<int> Entries = new List<int>();
        public string ProjectPath;
        public int Address = -1;
        public int Count = 32;
        public bool WritesOnly;
        public bool CodeOnly;
    }

    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            Options opt;
            try
            {
                opt = ParseArguments(args);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("argument error: " + ex.Message);
                return 2;
            }

            if (opt.Command == "help")
            {
                Console.Error.WriteLine(UsageText());
                return 1;
            }

            try
            {
                switch (opt.Command)
                {
                    case "info": return CmdInfo(opt);
                    case "build": return CmdBuild(opt);
                    case "stats": return CmdStats(opt);
                    case "xref": return CmdXref(opt);
                    case "line": return CmdLine(opt);
                    default:
                        Console.Error.WriteLine("unknown command: " + opt.Command);
                        return 2;
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(ex.GetType().Name + ": " + ex.Message);
                Console.Out.WriteLine("{\"ok\":false,\"error\":" + Json.Str(ex.Message) + "}");
                return 1;
            }
        }

        // ------------------------------------------------------------ commands

        private static int CmdInfo(Options opt)
        {
            byte[] data = ReadData(opt);
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"ok\":true,\"command\":\"info\"");
            sb.Append(",\"data\":").Append(Json.Str(opt.DataPath));
            sb.Append(",\"length\":").Append(data.Length);
            sb.Append(",\"baseAddress\":").Append(Json.Hex(opt.BaseAddress));
            sb.Append(",\"cpu\":").Append(Json.Str(CpuNameOf(opt)));
            sb.Append(",\"crc32\":").Append(Json.Str(CRC32.OnWholeBuffer(0, data).ToString("X8", CultureInfo.InvariantCulture)));
            sb.Append('}');
            Console.Out.WriteLine(sb.ToString());
            return 0;
        }

        private static int CmdBuild(Options opt)
        {
            DisasmProject project = Analyze(opt);
            string error = string.Empty;
            bool saved = false;
            if (!string.IsNullOrEmpty(opt.ProjectPath))
            {
                saved = ProjectFile.SerializeToFile(project, opt.ProjectPath, out error);
                if (!saved)
                {
                    Console.Error.WriteLine("project save failed: " + error);
                }
            }

            StringBuilder sb = new StringBuilder();
            sb.Append("{\"ok\":").Append(saved || string.IsNullOrEmpty(opt.ProjectPath) ? "true" : "false");
            sb.Append(",\"command\":\"build\"");
            sb.Append(",\"data\":").Append(Json.Str(opt.DataPath));
            sb.Append(",\"length\":").Append(project.FileDataLength);
            sb.Append(",\"baseAddress\":").Append(Json.Hex(opt.BaseAddress));
            sb.Append(",\"cpu\":").Append(Json.Str(project.CpuDef.Name));
            sb.Append(",\"projectSaved\":").Append(saved ? "true" : "false");
            if (!string.IsNullOrEmpty(opt.ProjectPath))
            {
                sb.Append(",\"projectPath\":").Append(Json.Str(opt.ProjectPath));
                if (!saved)
                {
                    sb.Append(",\"projectError\":").Append(Json.Str(error));
                }
            }
            AppendCoverage(sb, project, opt);
            sb.Append('}');
            Console.Out.WriteLine(sb.ToString());
            return saved || string.IsNullOrEmpty(opt.ProjectPath) ? 0 : 1;
        }

        private static int CmdStats(Options opt)
        {
            DisasmProject project = Analyze(opt);
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"ok\":true,\"command\":\"stats\"");
            AppendCoverage(sb, project, opt);
            sb.Append('}');
            Console.Out.WriteLine(sb.ToString());
            return 0;
        }

        /// <summary>
        /// Find instructions whose operand names the requested address.
        ///
        /// The analysis classifies only the bytes it can reach from a seed, and a
        /// bank-switched window supplies almost no seeds: in a 16 KB bank that is entirely
        /// code, nine tenths of the bytes stay unclassified. Walking the classified
        /// instructions alone therefore answered "nothing refers to this address" for
        /// addresses that ordinary code reads and writes, and an answer of "nothing" is
        /// worse than an error: the caller excludes a whole class of explanation.
        ///
        /// This scan decodes every byte and labels each hit with the evidence behind it.
        /// "code" means the analyzer agreed the byte starts an instruction. "raw" means
        /// only the opcode table was consulted, which is what makes unreached code and
        /// bank-switched routines visible. A raw hit is dropped when it starts inside a
        /// classified instruction or spans a classified instruction start, because those
        /// bytes are some real instruction's operand rather than code.
        ///
        /// Indirect modes name their pointer, not the address the instruction ends up
        /// touching; a hit on a zero-page address therefore means "look through it".
        /// </summary>
        private static int CmdXref(Options opt)
        {
            if (opt.Address < 0)
            {
                throw new ArgumentException("--address is required");
            }
            DisasmProject project = Analyze(opt);
            byte[] data = project.FileData;

            bool[] instructionStarts = new bool[data.Length];
            bool[] ownedByInstruction = new bool[data.Length];
            int classifiedInstructions = 0;
            for (int offset = 0; offset < data.Length; offset++)
            {
                Anattrib attrib = project.GetAnattrib(offset);
                if (!attrib.IsInstructionStart)
                {
                    continue;
                }
                instructionStarts[offset] = true;
                classifiedInstructions++;
                int span = Math.Max(1, attrib.Length);
                for (int i = offset; i < offset + span && i < data.Length; i++)
                {
                    ownedByInstruction[i] = true;
                }
            }

            StatusFlags flags = new StatusFlags();
            List<XrefHit> hits = new List<XrefHit>();
            int codeHits = 0;
            int rawHits = 0;
            int acceptedEnd = 0;
            for (int offset = 0; offset + 1 < data.Length; offset++)
            {
                OpDef op = project.CpuDef.GetOpDef(data[offset]);
                int length = op.GetLength(flags);
                if (length < 2 || offset + length > data.Length)
                {
                    continue;
                }

                bool isCode = instructionStarts[offset];
                if (!isCode)
                {
                    if (opt.CodeOnly || ownedByInstruction[offset] ||
                        SpansInstructionStart(instructionStarts, offset, length))
                    {
                        continue;
                    }
                }
                // Greedy: the first candidate to claim a byte range keeps it, so overlapping
                // decodings of the same bytes are reported once.
                if (offset < acceptedEnd)
                {
                    continue;
                }

                int target = OperandTarget(op, data, offset, length);
                if (target != opt.Address)
                {
                    continue;
                }
                bool writes = op.MemEffect == OpDef.MemoryEffect.Write ||
                    op.MemEffect == OpDef.MemoryEffect.ReadModifyWrite;
                if (opt.WritesOnly && !writes)
                {
                    continue;
                }

                acceptedEnd = offset + length;
                Anattrib here = project.GetAnattrib(offset);
                hits.Add(new XrefHit
                {
                    Offset = offset,
                    Length = length,
                    Op = op,
                    Writes = writes,
                    Code = isCode,
                    Region = isCode ? "code"
                        : here.IsVisited ? "data"
                        : "unvisited",
                });
                if (isCode)
                {
                    codeHits++;
                }
                else
                {
                    rawHits++;
                }
            }

            StringBuilder sb = new StringBuilder();
            sb.Append("{\"ok\":true,\"command\":\"xref\"");
            sb.Append(",\"address\":").Append(Json.Hex(opt.Address));
            sb.Append(",\"writesOnly\":").Append(opt.WritesOnly ? "true" : "false");
            sb.Append(",\"codeOnly\":").Append(opt.CodeOnly ? "true" : "false");
            sb.Append(",\"references\":[");
            for (int i = 0; i < hits.Count; i++)
            {
                XrefHit hit = hits[i];
                if (i > 0)
                {
                    sb.Append(',');
                }
                sb.Append("{\"byAddress\":").Append(Json.Hex(hit.Offset + opt.BaseAddress));
                sb.Append(",\"byOffset\":").Append(Json.Hex(hit.Offset));
                sb.Append(",\"op\":").Append(Json.Str(hit.Op.Mnemonic));
                sb.Append(",\"bytes\":").Append(Json.Str(ToHex(data, hit.Offset, hit.Length)));
                sb.Append(",\"effect\":").Append(Json.Str(hit.Op.MemEffect.ToString()));
                sb.Append(",\"mode\":").Append(Json.Str(hit.Op.AddrMode.ToString()));
                sb.Append(",\"indexed\":").Append(IsIndexedMode(hit.Op.AddrMode) ? "true" : "false");
                sb.Append(",\"indirect\":").Append(IsIndirectMode(hit.Op.AddrMode) ? "true" : "false");
                sb.Append(",\"writes\":").Append(hit.Writes ? "true" : "false");
                sb.Append(",\"tier\":").Append(Json.Str(hit.Code ? "code" : "raw"));
                sb.Append(",\"region\":").Append(Json.Str(hit.Region));
                sb.Append('}');
            }
            sb.Append(']');
            sb.Append(",\"scan\":{\"bytes\":").Append(data.Length);
            sb.Append(",\"classifiedInstructions\":").Append(classifiedInstructions);
            sb.Append(",\"code\":").Append(codeHits);
            sb.Append(",\"raw\":").Append(rawHits);
            sb.Append(",\"reported\":").Append(hits.Count);
            sb.Append("}}");
            Console.Out.WriteLine(sb.ToString());
            return 0;
        }

        /// <summary>True when a candidate instruction would swallow the start of a classified one.</summary>
        private static bool SpansInstructionStart(bool[] instructionStarts, int offset, int length)
        {
            for (int i = offset + 1; i < offset + length; i++)
            {
                if (instructionStarts[i])
                {
                    return true;
                }
            }
            return false;
        }

        /// <summary>One xref candidate, with the evidence that produced it.</summary>
        private sealed class XrefHit
        {
            public int Offset;
            public int Length;
            public OpDef Op;
            public bool Writes;
            public bool Code;
            public string Region;
        }

        /// <summary>Absolute or direct-page target named by an instruction operand, or -1.</summary>
        private static int OperandTarget(OpDef op, byte[] data, int offset, int length)
        {
            if (length < 2 || offset + 1 >= data.Length)
            {
                return -1;
            }
            int operand = data[offset + 1];
            if (length >= 3 && offset + 2 < data.Length)
            {
                operand |= data[offset + 2] << 8;
            }

            switch (op.AddrMode)
            {
                case OpDef.AddressMode.Abs:
                case OpDef.AddressMode.AbsIndexX:
                case OpDef.AddressMode.AbsIndexY:
                case OpDef.AddressMode.AbsInd:
                case OpDef.AddressMode.AbsIndexXInd:
                case OpDef.AddressMode.AbsLong:
                    return operand;
                case OpDef.AddressMode.DP:
                case OpDef.AddressMode.DPIndexX:
                case OpDef.AddressMode.DPIndexY:
                case OpDef.AddressMode.DPInd:
                case OpDef.AddressMode.DPIndIndexY:
                case OpDef.AddressMode.DPIndexXInd:
                    return operand & 0xFF;
                default:
                    return -1;
            }
        }

        private static bool IsIndexedMode(OpDef.AddressMode mode)
        {
            switch (mode)
            {
                case OpDef.AddressMode.AbsIndexX:
                case OpDef.AddressMode.AbsIndexY:
                case OpDef.AddressMode.DPIndexX:
                case OpDef.AddressMode.DPIndexY:
                case OpDef.AddressMode.DPIndIndexY:
                case OpDef.AddressMode.DPIndexXInd:
                    return true;
                default:
                    return false;
            }
        }

        /// <summary>True when the operand is a pointer: the hit names the pointer, not the target.</summary>
        private static bool IsIndirectMode(OpDef.AddressMode mode)
        {
            switch (mode)
            {
                case OpDef.AddressMode.AbsInd:
                case OpDef.AddressMode.AbsIndexXInd:
                case OpDef.AddressMode.DPInd:
                case OpDef.AddressMode.DPIndexXInd:
                case OpDef.AddressMode.DPIndIndexY:
                    return true;
                default:
                    return false;
            }
        }

        private static int CmdLine(Options opt)
        {
            if (opt.Address < 0)
            {
                throw new ArgumentException("--address is required");
            }
            DisasmProject project = Analyze(opt);
            int start = opt.Address - opt.BaseAddress;
            if (start < 0 || start >= project.FileDataLength)
            {
                throw new ArgumentException("address " + Json.Hex(opt.Address) + " is outside the mapped range");
            }

            StringBuilder sb = new StringBuilder();
            sb.Append("{\"ok\":true,\"command\":\"line\"");
            sb.Append(",\"address\":").Append(Json.Hex(opt.Address));
            sb.Append(",\"lines\":[");
            int offset = start;
            bool first = true;
            for (int i = 0; i < opt.Count && offset < project.FileDataLength; i++)
            {
                Anattrib attrib = project.GetAnattrib(offset);
                int length = Math.Max(1, attrib.Length);
                if (!first)
                {
                    sb.Append(',');
                }
                first = false;
                sb.Append("{\"address\":").Append(Json.Hex(offset + opt.BaseAddress));
                sb.Append(",\"offset\":").Append(Json.Hex(offset));
                sb.Append(",\"bytes\":").Append(Json.Str(ToHex(project.FileData, offset, length)));
                sb.Append(",\"kind\":").Append(Json.Str(attrib.IsInstruction ? "code" : attrib.IsInlineData ? "inline-data" : attrib.IsData ? "data" : "unknown"));
                if (attrib.IsInstruction)
                {
                    sb.Append(",\"op\":").Append(Json.Str(OpName(project, attrib, offset)));
                    sb.Append(",\"operand\":").Append(Json.Str(DescribeOperand(project, attrib, offset)));
                }
                sb.Append('}');
                offset += length;
            }
            sb.Append("]}");
            Console.Out.WriteLine(sb.ToString());
            return 0;
        }

        // ------------------------------------------------------------ analysis

        /// <summary>
        /// Load SourceGen's string table before analysis touches it.
        ///
        /// Every user-visible string in 6502bench is a XAML resource looked up through
        /// <c>Application.Current.FindResource</c>, and the analysis path formats messages
        /// with them. A console process has no <c>Application</c>, so its static
        /// initializer fails; merging the same dictionary gives it one without opening a
        /// window.
        /// </summary>
        private static void EnsureWpfResources()
        {
            if (System.Windows.Application.Current != null)
            {
                return;
            }
            System.Windows.Application application = new System.Windows.Application();
            application.Resources.MergedDictionaries.Add(new System.Windows.ResourceDictionary
            {
                Source = new Uri("pack://application:,,,/SourceGen;component/Res/Strings.xaml", UriKind.Absolute)
            });
        }

        private static DisasmProject Analyze(Options opt)
        {
            EnsureWpfResources();
            byte[] data = ReadData(opt);
            DisasmProject project = new DisasmProject();
            project.Initialize(data.Length);
            project.PrepForNew(data, Path.GetFileName(opt.DataPath));

            project.ProjectProps.CpuType = ParseCpu(opt.CpuName);
            project.ProjectProps.IncludeUndocumentedInstr = opt.IncludeUndocumented;
            project.ProjectProps.TwoByteBrk = opt.TwoByteBrk;
            project.UpdateCpuDef();

            project.AddrMap.Clear();
            AddressMap.AddResult mapResult = project.AddrMap.AddEntry(0, data.Length, opt.BaseAddress);
            if (mapResult != AddressMap.AddResult.Okay)
            {
                throw new Exception("the load address was rejected: " + mapResult);
            }

            // Seed the analyzer. Without at least one code tag the whole file stays
            // unclassified; every remaining entry point is optional.
            if (data.Length > 0)
            {
                project.AnalyzerTags[0] = CodeAnalysis.AnalyzerTag.Code;
            }

            // NES vector table at $FFFA-$FFFF: seeding its targets is what makes a
            // 16 KB bank analyse as a program instead of one dead routine. A bank that
            // does not map that address is left alone.
            int vectorOffset = 0xFFFA - opt.BaseAddress;
            if (vectorOffset >= 0 && vectorOffset + 6 <= data.Length)
            {
                string[] names = { "nmi", "reset", "irq" };
                for (int i = 0; i < 3; i++)
                {
                    int target = data[vectorOffset + i * 2] | (data[vectorOffset + i * 2 + 1] << 8);
                    int targetOffset = target - opt.BaseAddress;
                    if (targetOffset < 0 || targetOffset >= data.Length)
                    {
                        Console.Error.WriteLine(names[i] + " vector leaves this bank: " + Json.Hex(target));
                        continue;
                    }
                    project.AnalyzerTags[targetOffset] = CodeAnalysis.AnalyzerTag.Code;
                }
            }

            foreach (int entry in opt.Entries)
            {
                int offset = entry - opt.BaseAddress;
                if (offset < 0 || offset >= data.Length)
                {
                    Console.Error.WriteLine("entry point outside the mapped range, ignored: " + Json.Hex(entry));
                    continue;
                }
                project.AnalyzerTags[offset] = CodeAnalysis.AnalyzerTag.Code;
            }

            DebugLog log = new DebugLog();
            log.SetMinPriority(DebugLog.Priority.Silent);
            TaskTimer timer = new TaskTimer();
            project.Analyze(UndoableChange.ReanalysisScope.CodeAndData, log, timer);
            return project;
        }

        private static void AppendCoverage(StringBuilder sb, DisasmProject project, Options opt)
        {
            int codeBytes = 0;
            int dataBytes = 0;
            int unknownBytes = 0;
            int instructions = 0;
            int entryPoints = 0;
            for (int offset = 0; offset < project.FileDataLength; offset++)
            {
                Anattrib attrib = project.GetAnattrib(offset);
                if (attrib.IsInstruction)
                {
                    instructions++;
                    codeBytes += Math.Max(1, attrib.Length);
                }
                else if (attrib.IsData || attrib.IsInlineData)
                {
                    dataBytes += Math.Max(1, attrib.Length);
                }
                if (!attrib.IsVisited)
                {
                    unknownBytes++;
                }
                if (attrib.IsEntryPoint)
                {
                    entryPoints++;
                }
            }

            sb.Append(",\"coverage\":{");
            sb.Append("\"codeBytes\":").Append(codeBytes);
            sb.Append(",\"dataBytes\":").Append(dataBytes);
            sb.Append(",\"unvisitedBytes\":").Append(unknownBytes);
            sb.Append(",\"instructions\":").Append(instructions);
            sb.Append(",\"entryPoints\":").Append(entryPoints);
            sb.Append(",\"messages\":").Append(project.Messages.Count);
            sb.Append('}');
        }

        /// <summary>Mnemonic of the instruction at an offset, read through the project's CPU table.</summary>
        private static string OpName(DisasmProject project, Anattrib attrib, int offset)
        {
            if (!attrib.IsInstruction)
            {
                return "data";
            }
            OpDef op = project.CpuDef.GetOpDef(project.FileData[offset]);
            return op.Mnemonic;
        }

        /// <summary>Short operand text for a listing line, without the formatter.</summary>
        private static string DescribeOperand(DisasmProject project, Anattrib attrib, int offset)
        {
            int operandLength = attrib.Length - 1;
            if (operandLength <= 0)
            {
                return string.Empty;
            }
            int operand = 0;
            for (int i = 1; i <= operandLength; i++)
            {
                operand |= project.FileData[offset + i] << (8 * (i - 1));
            }
            return Json.Hex(operand);
        }

        // ------------------------------------------------------------ plumbing

        private static byte[] ReadData(Options opt)
        {
            if (string.IsNullOrEmpty(opt.DataPath))
            {
                throw new ArgumentException("--data is required");
            }
            return File.ReadAllBytes(opt.DataPath);
        }

        private static string ToHex(byte[] data, int offset, int length)
        {
            StringBuilder sb = new StringBuilder(length * 3);
            for (int i = 0; i < length && offset + i < data.Length; i++)
            {
                if (i > 0)
                {
                    sb.Append(' ');
                }
                sb.Append(data[offset + i].ToString("X2", CultureInfo.InvariantCulture));
            }
            return sb.ToString();
        }

        private static string CpuNameOf(Options opt)
        {
            return ParseCpu(opt.CpuName).ToString();
        }

        private static CpuDef.CpuType ParseCpu(string name)
        {
            switch ((name ?? string.Empty).Trim().ToLowerInvariant())
            {
                case "":
                case "2a03":
                case "nes":
                case "nes6502":
                    return CpuDef.CpuType.Cpu2A03;
                case "6502":
                    return CpuDef.CpuType.Cpu6502;
                case "65c02":
                    return CpuDef.CpuType.Cpu65C02;
                case "65816":
                    return CpuDef.CpuType.Cpu65816;
                default:
                    throw new ArgumentException("unknown CPU: " + name);
            }
        }

        private static Options ParseArguments(string[] args)
        {
            Options opt = new Options();
            if (args.Length == 0)
            {
                return opt;
            }

            int index = 0;
            if (!args[0].StartsWith("--"))
            {
                opt.Command = args[0].ToLowerInvariant();
                index = 1;
            }

            for (; index < args.Length; index++)
            {
                string token = args[index];
                if (!token.StartsWith("--"))
                {
                    throw new ArgumentException("unexpected positional argument: " + token);
                }
                string body = token.Substring(2);
                string name;
                string value;
                int equals = body.IndexOf('=');
                if (equals >= 0)
                {
                    name = body.Substring(0, equals);
                    value = body.Substring(equals + 1);
                }
                else
                {
                    name = body;
                    if (index + 1 < args.Length && !args[index + 1].StartsWith("--"))
                    {
                        value = args[++index];
                    }
                    else
                    {
                        value = "true";
                    }
                }

                switch (name.ToLowerInvariant())
                {
                    case "data": opt.DataPath = value; break;
                    case "base": opt.BaseAddress = ParseNumber(value); break;
                    case "cpu": opt.CpuName = value; break;
                    case "entry": opt.Entries.Add(ParseNumber(value)); break;
                    case "save-project": opt.ProjectPath = value; break;
                    case "address": opt.Address = ParseNumber(value); break;
                    case "count": opt.Count = ParseNumber(value); break;
                    case "no-undocumented": opt.IncludeUndocumented = false; break;
                    case "two-byte-brk": opt.TwoByteBrk = true; break;
                    case "writes-only": opt.WritesOnly = true; break;
                    case "code-only": opt.CodeOnly = true; break;
                    default:
                        throw new ArgumentException("unknown option: --" + name);
                }
            }

            return opt;
        }

        private static int ParseNumber(string text)
        {
            string trimmed = (text ?? string.Empty).Trim();
            bool negative = trimmed.StartsWith("-");
            if (negative)
            {
                trimmed = trimmed.Substring(1);
            }
            int value;
            if (trimmed.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            {
                value = int.Parse(trimmed.Substring(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
            }
            else if (trimmed.EndsWith("h", StringComparison.OrdinalIgnoreCase))
            {
                value = int.Parse(trimmed.Substring(0, trimmed.Length - 1), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
            }
            else
            {
                value = int.Parse(trimmed, CultureInfo.InvariantCulture);
            }
            return negative ? -value : value;
        }

        private static string UsageText()
        {
            return
                "usage: SourceGenCli <info|build|stats|xref|line> --data <file> [options]\n" +
                "  --base 0x8000          load address of the first data byte\n" +
                "  --cpu 2a03|6502|65c02|65816\n" +
                "  --entry 0x8000         extra entry point (repeatable)\n" +
                "  --save-project <path>  write a .dis65 project the GUI can open\n" +
                "  --address 0x0324       CPU address for xref/line\n" +
                "  --count 32             lines to print for line\n" +
                "  --writes-only          only report writes for xref\n" +
                "  --code-only            only report hits the analyzer classified as code\n" +
                "  --no-undocumented      exclude undocumented opcodes\n" +
                "Output is JSON on stdout; diagnostics go to stderr.";
        }
    }

    /// <summary>Minimal JSON writer: the project targets .NET Framework, which has no System.Text.Json.</summary>
    internal static class Json
    {
        public static string Str(string value)
        {
            if (value == null)
            {
                return "null";
            }
            StringBuilder sb = new StringBuilder(value.Length + 2);
            sb.Append('"');
            foreach (char c in value)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20)
                        {
                            sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            sb.Append(c);
                        }
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        public static string Hex(int value)
        {
            return Str("$" + value.ToString("X4", CultureInfo.InvariantCulture));
        }
    }
}
