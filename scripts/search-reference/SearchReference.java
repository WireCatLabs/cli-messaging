import java.io.*;
import java.nio.file.*;
import java.util.*;
import org.apache.lucene.analysis.core.WhitespaceAnalyzer;
import org.apache.lucene.analysis.core.KeywordAnalyzer;
import org.apache.lucene.analysis.miscellaneous.PerFieldAnalyzerWrapper;
import org.apache.lucene.document.*;
import org.apache.lucene.index.*;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.apache.lucene.search.*;
import org.apache.lucene.queryparser.flexible.precedence.PrecedenceQueryParser;
import org.apache.lucene.queryparser.flexible.standard.config.StandardQueryConfigHandler.Operator;
import org.apache.lucene.queryparser.flexible.standard.parser.StandardSyntaxParser;
public class SearchReference {
  static String json(String s) { return "\""+s.replace("\\","\\\\").replace("\"","\\\"").replace("\n","\\n").replace("\r","\\r").replace("\t","\\t")+"\""; }
  public static void main(String[] args) throws Exception {
    var analyzer = new PerFieldAnalyzerWrapper(new WhitespaceAnalyzer(), Map.of("body",new KeywordAnalyzer(),"from",new KeywordAnalyzer(),"kind",new KeywordAnalyzer()));
    var directory = new ByteBuffersDirectory();
    var writer = new IndexWriter(directory, new IndexWriterConfig(analyzer));
    String[] tokens = {"alpha", "beta", "gamma", "delta"};
    for (int mask=0;mask<16;mask++) {
      var words = new ArrayList<String>();
      for (int i=0;i<4;i++) if ((mask & (1<<i))!=0) words.add(tokens[i]);
      var doc = new Document();
      doc.add(new StringField("id", ""+mask, Field.Store.YES));
      doc.add(new TextField("text", String.join(" ",words), Field.Store.YES));
      doc.add(new StringField("body", String.join(" ",words), Field.Store.NO));
      doc.add(new StringField("from", mask%2==0?"alice":"bob", Field.Store.NO));
      doc.add(new StringField("kind", mask%2==0?"group":"private", Field.Store.NO));
      writer.addDocument(doc);
    }
    writer.close();
    var reader = DirectoryReader.open(directory);
    var searcher = new IndexSearcher(reader);
    var parser = new PrecedenceQueryParser(analyzer);
    parser.setDefaultOperator(Operator.AND);
    parser.setAllowLeadingWildcard(true);
    parser.setMultiTermRewriteMethod(MultiTermQuery.CONSTANT_SCORE_REWRITE);
    System.out.println("[");
    boolean first=true;
    for (String input: Files.readAllLines(Path.of(args[0]))) {
      if (!first) System.out.println(","); first=false;
      try {
        var syntax = new StandardSyntaxParser().parse(input,"text");
        var query = parser.parse(input,"text");
        var ids = new ArrayList<Integer>();
        for (var hit : searcher.search(query,32).scoreDocs) ids.add(Integer.parseInt(searcher.storedFields().document(hit.doc).get("id")));
        Collections.sort(ids);
        System.out.print("{\"query\":"+json(input)+",\"parsed\":true,\"luceneQuery\":"+json(query.toString())+",\"syntax\":"+json(syntax.toString())+",\"ids\":"+ids+"}");
      } catch (Exception e) { System.out.print("{\"query\":"+json(input)+",\"parsed\":false,\"error\":"+json(e.getClass().getSimpleName())+"}"); }
    }
    System.out.println("\n]"); reader.close(); directory.close(); analyzer.close();
  }
}
